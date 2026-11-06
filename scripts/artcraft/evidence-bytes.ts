import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarString(bytes: Buffer): string {
  const end = bytes.indexOf(0);

  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

function octal(bytes: Buffer): number {
  const text = tarString(bytes).trim();

  if (!/^[0-7]+$/.test(text)) throw new Error("Unsupported tar numeric field");

  const value = Number.parseInt(text, 8);

  if (!Number.isSafeInteger(value)) throw new Error("Tar numeric overflow");

  return value;
}

// Deliberately narrow: crates.io's regular-file/directory ustar archives only. Parse and
// validate the ENTIRE archive before exposing any entries. Never run tar or upstream code.
export function readCrateArchive(bytes: Buffer, root: string): Map<string, Buffer> {
  return readTarArchive(bytes, root, 32 * 1024 * 1024);
}

export function readGitSourceArchive(
  bytes: Buffer,
  root: string,
  commit: string,
): Map<string, Buffer> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid Git commit");

  return readTarArchive(bytes, root, 128 * 1024 * 1024, commit);
}

export function readToolArchive(bytes: Buffer): Map<string, Buffer> {
  return readTarArchive(bytes, null, 512 * 1024 * 1024, undefined, 128 * 1024 * 1024);
}

function readTarArchive(
  bytes: Buffer,
  root: string | null,
  maxOutputLength: number,
  gitCommit?: string,
  maxEntryBytes = 16 * 1024 * 1024,
): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength });
  const files = new Map<string, Buffer>();
  const paths = new Set<string>();
  let offset = 0;
  let gitHeaderVerified = false;
  let longPath: string | undefined;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Invalid tar terminator");

      if (gitCommit && !gitHeaderVerified) throw new Error("Missing pinned Git archive header");

      if (longPath) throw new Error("Orphaned GNU long path");

      return files;
    }

    if (paths.size >= 10_000) throw new Error("Tar entry count exceeded");

    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );

    if (octal(header.subarray(148, 156)) !== checksum)
      throw new Error("Tar header checksum mismatch");

    const size = octal(header.subarray(124, 136));
    const type = header[156];
    const prefix = tarString(header.subarray(345, 500));
    const name = tarString(header.subarray(0, 100));

    // GitHub codeload adds exactly one global PAX comment naming the immutable commit.
    // Do not accept path/size/link overrides, extension headers or scripts from archives.
    if (gitCommit && offset === 0 && type === 103) {
      const body = tar.subarray(512, 512 + size).toString("utf8");

      if (
        name !== "pax_global_header" ||
        prefix ||
        size !== 52 ||
        body !== `52 comment=${gitCommit}\n`
      )
        throw new Error("Unexpected Git archive metadata");

      gitHeaderVerified = true;
      offset += 1024;
      continue;
    }

    if (type === 76 && name === "././@LongLink" && !prefix && !longPath) {
      if (size < 2 || size > 4096 || offset + 512 + size > tar.length)
        throw new Error("Invalid GNU long path bounds");

      const payload = tar.subarray(offset + 512, offset + 512 + size);

      if (payload[payload.length - 1] !== 0 || payload.subarray(0, -1).includes(0))
        throw new Error("Invalid GNU long path terminator");

      longPath = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(0, -1));
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    if (longPath && (prefix || !longPath.startsWith(name)))
      throw new Error("GNU long path/header mismatch");

    let full = (longPath ?? `${prefix ? `${prefix}/` : ""}${name}`).replace(/\/$/, "");
    longPath = undefined;

    if (root === null && full === "." && type === 53 && size === 0) {
      offset += 512;
      continue;
    }

    if (root === null && full.startsWith("./")) full = full.slice(2);

    const segments = full.split("/");

    if (
      (root !== null && segments[0] !== root) ||
      segments.some((part) => !part || part === "." || part === "..") ||
      /[\\:]/.test(full) ||
      [...full].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error(`Unsafe tar path: ${full}`);

    if (
      (type !== 0 && type !== 48 && type !== 53) ||
      tarString(header.subarray(157, 257)) !== "" ||
      (type === 53 && size !== 0) ||
      size > maxEntryBytes
    )
      throw new Error(`Unsupported tar entry: ${full}`);

    if (paths.has(full)) throw new Error(`Duplicate tar path: ${full}`);

    for (let index = 1; index < segments.length; index++) {
      if (files.has(segments.slice(root === null ? 0 : 1, index).join("/")))
        throw new Error(`Tar file/directory collision: ${full}`);
    }

    const path = segments.slice(root === null ? 0 : 1).join("/");

    if (type !== 53 && [...paths].some((existing) => existing.startsWith(`${full}/`)))
      throw new Error(`Tar file/directory collision: ${full}`);

    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;

    if (next > tar.length) throw new Error("Truncated tar payload");

    if (type !== 53) {
      if (!path) throw new Error("Tar root must be a directory");

      files.set(path, tar.subarray(offset + 512, end));
    }

    paths.add(full);
    offset = next;
  }

  throw new Error("Missing tar terminator");
}

// Extract human-readable copyright/name/licence records, never redistribute font assets.
export function fontNames(bytes: Buffer): Buffer {
  if (bytes.length < 12) throw new Error("Truncated sfnt header");

  const tables = bytes.readUInt16BE(4);

  for (let index = 0; index < tables; index++) {
    const entry = 12 + index * 16;

    if (entry + 16 > bytes.length) throw new Error("Truncated sfnt directory");

    if (bytes.toString("ascii", entry, entry + 4) !== "name") continue;

    const offset = bytes.readUInt32BE(entry + 8);
    const size = bytes.readUInt32BE(entry + 12);

    if (size < 6 || offset + size > bytes.length) throw new Error("Invalid sfnt name table");

    const table = bytes.subarray(offset, offset + size);
    const count = table.readUInt16BE(2);
    const strings = table.readUInt16BE(4);
    const records: { nameId: number; text: string }[] = [];

    if (6 + count * 12 > strings || strings > size) throw new Error("Invalid sfnt records");

    for (let record = 0; record < count; record++) {
      const start = 6 + record * 12;
      const platform = table.readUInt16BE(start);
      const nameId = table.readUInt16BE(start + 6);
      const length = table.readUInt16BE(start + 8);
      const position = strings + table.readUInt16BE(start + 10);

      if (position + length > size) throw new Error("Invalid sfnt string bounds");

      if (![0, 1, 6, 13, 14].includes(nameId) || ![0, 3].includes(platform)) continue;

      if (length % 2 !== 0) throw new Error("Invalid sfnt UTF-16 string");

      const text = new TextDecoder("utf-16be", { fatal: true }).decode(
        table.subarray(position, position + length),
      );

      if (!records.some((item) => item.nameId === nameId && item.text === text))
        records.push({ nameId, text });
    }

    if (!records.some((record) => record.nameId === 0)) throw new Error("Missing font copyright");

    records.sort((a, b) => a.nameId - b.nameId || a.text.localeCompare(b.text, "en"));

    return Buffer.from(`${JSON.stringify(records, null, 2)}\n`);
  }

  throw new Error("Missing sfnt name table");
}

export function leadingComments(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8");
  const header = text.match(/^(?:%[^\n]*(?:\n|$))+/)?.[0];

  if (!header || !header.includes("Permission is hereby granted"))
    throw new Error("Missing hyphenation permission header");

  return Buffer.from(header);
}

export function symphoniaHeaders(files: Map<string, Buffer>): Buffer {
  const sections: string[] = [];

  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!path.endsWith(".rs")) continue;

    const header = bytes.toString("utf8").match(/^(?:\/\/[^\n]*(?:\n|$)|\s*\n)+/)?.[0];

    sections.push(
      `=== ${path} ===\n${
        header?.includes("Copyright") || header?.includes("Mozilla Public")
          ? header
          : "[No leading copyright/MPL notice in this upstream file; see package metadata.]\n"
      }`,
    );
  }

  if (sections.length === 0) throw new Error("Missing Symphonia source files");

  return Buffer.from(sections.join("\n"));
}

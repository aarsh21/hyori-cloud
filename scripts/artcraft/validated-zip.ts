import { crc32, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
}

interface ZipEntry {
  path: string;
  directory: boolean;
  method: number;
  checksum: number;
  expandedBytes: number;
  compressed: Buffer;
}

// This deliberately supports only the classic, single-disk, store/deflate ZIP subset used by
// the pinned releases. Validate the entire directory and local headers before writing a file.
export function validateZipArchive(
  archive: Buffer,
  expectedRoot: string | null,
  limits: ZipLimits,
): readonly ZipEntry[] {
  let end = archive.length - 22;

  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50)
    end -= 1;

  if (
    end < 0 ||
    end + 22 > archive.length ||
    archive.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + archive.readUInt16LE(end + 20) !== archive.length ||
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== archive.readUInt16LE(end + 10)
  ) {
    throw new Error("Unsupported or malformed ZIP end record");
  }

  const count = archive.readUInt16LE(end + 10);
  const centralBytes = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);

  if (count === 0 || count > limits.maxEntries || centralOffset + centralBytes !== end)
    throw new Error("Invalid ZIP directory bounds");

  const entries: ZipEntry[] = [];
  const paths = new Map<string, boolean>();
  const ranges: { start: number; end: number }[] = [];
  let offset = centralOffset;
  let expandedTotal = 0;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");

    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedBytes = archive.readUInt32LE(offset + 20);
    const expandedBytes = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const disk = archive.readUInt16LE(offset + 34);
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    const localOffset = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;

    if (
      next > end ||
      disk !== 0 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(method) ||
      compressedBytes === 0xffffffff ||
      localOffset === 0xffffffff ||
      expandedBytes > limits.maxEntryBytes ||
      ![0, 0x8000, 0x4000].includes(mode & 0xf000)
    )
      throw new Error("Unsupported ZIP entry");

    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    const directory = name.endsWith("/");
    const components = name.replace(/\/$/, "").split("/");

    if (
      (expectedRoot !== null && components[0] !== expectedRoot) ||
      components.some(
        (part) => !part || part === "." || part === ".." || /[\\:\p{Cc}\p{Cf}]/u.test(part),
      ) ||
      ((mode & 0xf000) === 0x4000 && !directory) ||
      (expectedRoot !== null && components.length === 1 && !directory)
    )
      throw new Error("Unsafe ZIP path");

    const path = components.slice(expectedRoot === null ? 0 : 1).join("/");

    if (paths.has(path)) throw new Error("Duplicate ZIP path");

    paths.set(path, directory);
    expandedTotal += expandedBytes;

    if (expandedTotal > limits.maxExpandedBytes || (directory && expandedBytes !== 0))
      throw new Error("ZIP expansion limit exceeded");

    if (
      localOffset + 30 > centralOffset ||
      archive.readUInt32LE(localOffset) !== 0x04034b50 ||
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method
    )
      throw new Error("Invalid ZIP local header");

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedBytes;

    if (
      dataEnd > centralOffset ||
      !archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) ||
      ((flags & 8) === 0 &&
        (archive.readUInt32LE(localOffset + 14) !== checksum ||
          archive.readUInt32LE(localOffset + 18) !== compressedBytes ||
          archive.readUInt32LE(localOffset + 22) !== expandedBytes))
    )
      throw new Error("Inconsistent ZIP local entry");

    ranges.push({ start: localOffset, end: dataEnd });
    entries.push({
      path,
      directory,
      method,
      checksum,
      expandedBytes,
      compressed: archive.subarray(dataOffset, dataEnd),
    });
    offset = next;
  }

  if (offset !== end) throw new Error("ZIP directory size mismatch");

  ranges.sort((a, b) => a.start - b.start);

  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];

    if (previous && current && previous.end > current.start)
      throw new Error("Overlapping ZIP entries");
  }

  for (const entry of entries) {
    const parts = entry.path.split("/");

    for (let index = 1; index < parts.length; index += 1) {
      if (paths.get(parts.slice(0, index).join("/")) === false)
        throw new Error("ZIP file/directory collision");
    }
  }

  return entries;
}

export function expandZipEntry(entry: ZipEntry): Buffer {
  const bytes =
    entry.method === 0
      ? entry.compressed
      : inflateRawSync(entry.compressed, { maxOutputLength: Math.max(1, entry.expandedBytes) });

  if (bytes.length !== entry.expandedBytes || crc32(bytes) !== entry.checksum)
    throw new Error("ZIP entry integrity check failed");

  return bytes;
}

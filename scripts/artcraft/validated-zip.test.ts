import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import manifest from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { acquireArtCraft } from "./acquire.ts";
import { expandZipEntry, validateZipArchive } from "./validated-zip.ts";

const limits = { maxEntries: 100, maxExpandedBytes: 1024, maxEntryBytes: 512 };

function zip(
  entries: readonly {
    name: string;
    content?: string;
    mode?: number;
    flags?: number;
    method?: number;
  }[],
): Buffer {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.content ?? "test");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }

  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, central, end]);
}

describe("bounded flat native ZIP fixtures", () => {
  test("flat mode preserves complete paths without weakening the release-root requirement", () => {
    const bytes = zip([
      { name: "presentation.json", content: "{}" },
      { name: "media/1", content: "synthetic" },
    ]);

    expect(validateZipArchive(bytes, null, limits).map((entry) => entry.path)).toEqual([
      "presentation.json",
      "media/1",
    ]);
    expect(() => validateZipArchive(bytes, "release", limits)).toThrow("Unsafe ZIP path");
  });
  test("flat mode retains traversal, collision, link and expansion protections", () => {
    for (const name of ["../escape", "/absolute", "a/../b", "a//b", "a\\b"])
      expect(() => validateZipArchive(zip([{ name }]), null, limits)).toThrow();
    expect(() => validateZipArchive(zip([{ name: "a" }, { name: "a/b" }]), null, limits)).toThrow();
    expect(() => validateZipArchive(zip([{ name: "a", mode: 0xa1ff }]), null, limits)).toThrow();
    expect(() =>
      validateZipArchive(zip([{ name: "a", content: "a".repeat(513) }]), null, limits),
    ).toThrow();
  });
});

describe("pinned ArtCraft acquisition safety", () => {
  test("validates store and deflate payloads before expansion", () => {
    const entries = validateZipArchive(
      zip([
        { name: "release/index.html", content: "<html></html>", method: 0 },
        { name: "release/app.wasm", content: "wasm" },
      ]),
      "release",
      limits,
    );

    expect(entries.map((entry) => entry.path)).toEqual(["index.html", "app.wasm"]);
    expect(entries.map((entry) => expandZipEntry(entry).toString())).toEqual([
      "<html></html>",
      "wasm",
    ]);
  });

  for (const name of [
    "../escape",
    "/absolute",
    "release/../escape",
    "release/./escape",
    "release//escape",
    "release/a\\b",
    "release/C:drive",
    "release/a\u0000b",
    "other/app.wasm",
  ]) {
    test(`rejects unsafe path ${JSON.stringify(name)} before extraction`, () => {
      expect(() => validateZipArchive(zip([{ name }]), "release", limits)).toThrow(
        "Unsafe ZIP path",
      );
    });
  }

  test("rejects symlinks, encrypted entries, unsupported compression and file/dir collisions", () => {
    for (const entry of [
      { name: "release/link", mode: 0xa1ff },
      { name: "release/encrypted", flags: 1 },
      { name: "release/compressed", method: 99 },
    ])
      expect(() => validateZipArchive(zip([entry]), "release", limits)).toThrow(
        "Unsupported ZIP entry",
      );
    expect(() =>
      validateZipArchive(zip([{ name: "release/a" }, { name: "release/a/b" }]), "release", limits),
    ).toThrow("collision");
    expect(() =>
      validateZipArchive(zip([{ name: "release/a" }, { name: "release/a" }]), "release", limits),
    ).toThrow("Duplicate ZIP path");
  });

  test("bounds entry count, per-entry and total expansion, including forged deflate size", () => {
    expect(() =>
      validateZipArchive(
        zip([{ name: "release/big", content: "x".repeat(513) }]),
        "release",
        limits,
      ),
    ).toThrow();
    expect(() =>
      validateZipArchive(
        zip(
          Array.from({ length: 3 }, (_, index) => ({
            name: `release/${index}`,
            content: "x".repeat(400),
          })),
        ),
        "release",
        limits,
      ),
    ).toThrow("expansion limit");
    expect(() =>
      validateZipArchive(zip([{ name: "release/a" }]), "release", { ...limits, maxEntries: 0 }),
    ).toThrow("directory bounds");
    const forged = zip([{ name: "release/bomb", content: "x".repeat(2000) }]);
    const central = forged.readUInt32LE(forged.length - 6);
    forged.writeUInt32LE(5, 22);
    forged.writeUInt32LE(5, central + 24);
    const parsed = validateZipArchive(forged, "release", limits);
    expect(() => parsed.map(expandZipEntry)).toThrow();
  });

  test("rejects mismatched local paths, overlapping records, truncated archives and checksum corruption", () => {
    const mismatch = zip([{ name: "release/a" }]);
    mismatch[30] = "x".charCodeAt(0);
    expect(() => validateZipArchive(mismatch, "release", limits)).toThrow(
      "Inconsistent ZIP local entry",
    );
    const overlap = zip([{ name: "release/a" }, { name: "release/b" }]);
    const central = overlap.readUInt32LE(overlap.length - 6);
    const secondCentral = central + 46 + Buffer.byteLength("release/a");
    overlap.writeUInt32LE(0, secondCentral + 42);
    expect(() => validateZipArchive(overlap, "release", limits)).toThrow();
    expect(() => validateZipArchive(Buffer.alloc(5), "release", limits)).toThrow();
    const corrupt = zip([{ name: "release/a", method: 0 }]);
    corrupt[30 + Buffer.byteLength("release/a")] = 0;
    expect(() => validateZipArchive(corrupt, "release", limits).map(expandZipEntry)).toThrow(
      "integrity",
    );
  });

  test("preserved legal files and tagged protocol evidence match the acquisition manifest", async () => {
    for (const release of manifest.editors) {
      for (const file of [...release.legal, ...release.evidence]) {
        const bytes = await readFile(
          new URL(`../../tooling/artcraft/${file.path}`, import.meta.url),
        );

        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      }

      expect(release.legal.some((legal) => legal.path.endsWith("LICENSE-MIT"))).toBe(true);
      expect(release.legal.some((legal) => legal.path.endsWith("LICENSE-APACHE"))).toBe(true);
      expect(release.legal.some((legal) => legal.path.endsWith("NOTICE"))).toBe(true);
    }

    expect(manifest.editors.find((release) => release.app === "deckcraft")?.bridge).toBe(
      "blocked-no-host-bridge",
    );
    expect(manifest.evidence.wasmExecuted).toBe(false);
  });

  test("never overwrites an existing destination or starts a download for it", async () => {
    await expect(acquireArtCraft(resolve("tooling/artcraft/fixtures"))).rejects.toThrow(
      "Refusing to overwrite",
    );
  });
});

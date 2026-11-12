import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import evidence from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import {
  fontNames,
  leadingComments,
  readCrateArchive,
  readToolArchive,
  symphoniaHeaders,
} from "./evidence-bytes.ts";
import {
  checkRedistributionEvidence,
  supplementalLegalFiles,
  symphoniaSourceNotice,
} from "./redistribution.ts";

function crate(entries: { path: string; type?: string; content?: string }[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const bytes = Buffer.from(entry.content ?? "notice");
    header.write(entry.path);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
    );
    const payload = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
    bytes.copy(payload);
    blocks.push(header, payload);
  }

  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("ArtCraft redistribution evidence (partial, not approval)", () => {
  test("verifies all retained files and the sixteen MPL matching-source references offline", async () => {
    const files = await checkRedistributionEvidence();
    expect(files.size).toBe(161);
    expect(
      supplementalLegalFiles().filter((file) => file.path.startsWith("licenses/shared/")).length,
    ).toBe(7);
    expect(evidence.deployable).toBe(false);
    const notice = symphoniaSourceNotice();

    for (const pkg of evidence.symphonia) {
      const source = evidence.sources.find((item) => item.id === pkg.source)!;
      expect(notice).toContain(source.url);
      expect(notice).toContain(source.sha256);
      expect(notice).toContain(String(source.bytes));
    }

    expect(notice).toContain("not an exact production wasm32 feature-closure claim");
    expect(notice).toContain("whole Hyori application is not thereby required");
  });

  for (const id of [
    "egui-UFL.txt",
    "egui-Ubuntu-Light.ttf",
    "egui-Hack-Regular.txt",
    "egui-NotoEmoji-Regular.ttf",
    "egui-emoji-icon-font-mit-license.txt",
    "polish-hyphenation",
    "hayro-icc-cc0",
    "symphonia-mpl",
    "symphonia-core-0.5.5-copyrights",
  ]) {
    test(`rejects a missing required notice/header: ${id}`, async () => {
      const changed = structuredClone(evidence);
      changed.files = changed.files.filter((file) => file.id !== id);
      await expect(checkRedistributionEvidence(changed)).rejects.toThrow("missing required");
    });
  }

  test("rejects stale egui attribution and incorrect matching-source checksums", async () => {
    const stale = structuredClone(evidence);
    stale.sources.find((source) => source.id === "egui-UFL.txt")!.url =
      "https://raw.githubusercontent.com/storytold/egui/0000000000000000000000000000000000000000/crates/epaint_default_fonts/fonts/UFL.txt";
    await expect(checkRedistributionEvidence(stale)).rejects.toThrow("wrong font revision");
    const wrong = structuredClone(evidence);
    wrong.sources.find((source) => source.id === "symphonia-0.5.5")!.sha256 = "0".repeat(64);
    await expect(checkRedistributionEvidence(wrong)).rejects.toThrow(
      "incorrect matching-source reference",
    );
  });

  test("rejects incomplete MPL inventory and a false deployment-approval claim", async () => {
    const incomplete = structuredClone(evidence);
    incomplete.symphonia.pop();
    await expect(checkRedistributionEvidence(incomplete)).rejects.toThrow(
      "incomplete locked Symphonia",
    );
    const approved = structuredClone(evidence);
    approved.deployable = true;
    await expect(checkRedistributionEvidence(approved)).rejects.toThrow("deployment gates");
  });

  test("rejects mutable source URLs, unknown transforms and unsafe paths", async () => {
    for (const mutation of ["url", "transform", "path"]) {
      const changed = structuredClone(evidence);

      if (mutation === "url")
        changed.sources[0]!.url = changed.sources[0]!.url.replace(
          evidence.editorCommits.wordcraft,
          "main",
        );

      if (mutation === "transform") changed.files[0]!.transform = "run-upstream-script";

      if (mutation === "path") changed.files[0]!.path = "../outside";

      await expect(checkRedistributionEvidence(changed)).rejects.toThrow(
        "ArtCraft redistribution evidence",
      );
    }
  });

  test("detects altered legal bytes without changing any upstream retained files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyori-artcraft-test-"));

    try {
      const source = new URL("../../tooling/artcraft/", import.meta.url);
      await cp(new URL("licenses/", source), join(directory, "licenses"), { recursive: true });
      await cp(new URL("fixtures/", source), join(directory, "fixtures"), { recursive: true });
      await cp(new URL("evidence/", source), join(directory, "evidence"), { recursive: true });
      const path = join(directory, "licenses/shared/egui/UFL.txt");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\nchanged\n")]));
      await expect(checkRedistributionEvidence(evidence, directory)).rejects.toThrow(
        "checksum mismatch",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("bounded build-tool archives", () => {
  test("supports flat tools and one dot prefix without changing source-reader semantics", () => {
    const bytes = crate([
      { path: "./", type: "5", content: "" },
      { path: "./trunk", content: "synthetic executable bytes" },
    ]);

    expect(readToolArchive(bytes).get("trunk")?.toString()).toBe("synthetic executable bytes");
    expect(() => readCrateArchive(bytes, "pkg-1.0")).toThrow();
  });
  test("rejects tool links, traversal, duplicate normalized paths and collisions", () => {
    for (const entries of [
      [{ path: "tool", type: "2" }],
      [{ path: "./../outside" }],
      [{ path: "././tool" }],
      [{ path: "/tool" }],
      [{ path: "./tool" }, { path: "tool" }],
      [{ path: "bin" }, { path: "bin/tool" }],
      [{ path: "bin/tool" }, { path: "bin" }],
    ])
      expect(() => readToolArchive(crate(entries))).toThrow();
  });
  test("rejects an entry declaring more than the separate 128 MiB tool limit", () => {
    const tar = gunzipSync(crate([{ path: "tool" }]));
    tar.write(`${(128 * 1024 * 1024 + 1).toString(8).padStart(11, "0")}\0`, 124);
    tar.fill(32, 148, 156);
    const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readToolArchive(gzipSync(tar))).toThrow("Unsupported tar entry");
  });
});

describe("source archives are data, never executable", () => {
  test("reads regular crate entries only after complete validation", () => {
    const files = readCrateArchive(
      crate([{ path: "pkg-1.0/LICENSE", content: "licence" }]),
      "pkg-1.0",
    );

    expect(files.get("LICENSE")?.toString()).toBe("licence");
  });

  for (const path of [
    "../escape",
    "/absolute",
    "pkg-1.0/../escape",
    "pkg-1.0//file",
    "pkg-1.0/a\\b",
    "pkg-1.0/C:drive",
    "other/file",
    "pkg-1.0/control\u0001",
  ]) {
    test(`rejects unsafe tar path ${JSON.stringify(path)}`, () => {
      expect(() => readCrateArchive(crate([{ path }]), "pkg-1.0")).toThrow("Unsafe tar path");
    });
  }

  test("rejects links, extension headers, duplicate and colliding paths", () => {
    for (const type of ["1", "2", "x", "L"])
      expect(() => readCrateArchive(crate([{ path: "pkg-1.0/link", type }]), "pkg-1.0")).toThrow(
        "Unsupported tar entry",
      );
    expect(() =>
      readCrateArchive(crate([{ path: "pkg-1.0/a" }, { path: "pkg-1.0/a" }]), "pkg-1.0"),
    ).toThrow("Duplicate tar path");

    for (const paths of [
      ["pkg-1.0/a", "pkg-1.0/a/b"],
      ["pkg-1.0/a/b", "pkg-1.0/a"],
    ])
      expect(() => readCrateArchive(crate(paths.map((path) => ({ path }))), "pkg-1.0")).toThrow(
        "collision",
      );
  });

  test("rejects corrupt gzip, missing terminators, invalid headers and expansion bombs", () => {
    expect(() => readCrateArchive(Buffer.from("invalid"), "pkg-1.0")).toThrow();
    expect(() => readCrateArchive(gzipSync(Buffer.alloc(512)), "pkg-1.0")).toThrow("terminator");
    const damaged = Buffer.alloc(1536);
    damaged.write("pkg-1.0/file");
    expect(() => readCrateArchive(gzipSync(damaged), "pkg-1.0")).toThrow();
    expect(() => readCrateArchive(gzipSync(Buffer.alloc(33 * 1024 * 1024)), "pkg-1.0")).toThrow();
  });

  test("retains complete pattern comments verbatim and inventories absent source headers honestly", () => {
    const header = "% Copyright Someone\n% Permission is hereby granted\n% disclaimer\n";
    expect(leadingComments(Buffer.from(`${header}\\patterns{data}`)).toString()).toBe(header);
    expect(() => leadingComments(Buffer.from("no header"))).toThrow();
    expect(
      symphoniaHeaders(new Map([["src/a.rs", Buffer.from("fn a() {}")]])).toString(),
    ).toContain("No leading copyright/MPL notice");
    expect(() => symphoniaHeaders(new Map())).toThrow("Missing Symphonia source files");
  });

  test("bounds font metadata parsing and requires an actual copyright record", () => {
    expect(() => fontNames(Buffer.alloc(8))).toThrow("Truncated sfnt");
    expect(() => fontNames(Buffer.alloc(12))).toThrow("Missing sfnt name table");
    const font = Buffer.alloc(28);
    font.writeUInt16BE(1, 4);
    font.write("name", 12);
    font.writeUInt32BE(5000, 20);
    font.writeUInt32BE(100, 24);
    expect(() => fontNames(font)).toThrow("Invalid sfnt name table");
  });
});

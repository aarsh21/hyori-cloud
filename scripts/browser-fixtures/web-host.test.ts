import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest } from "./web-host.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function artifact() {
  const parent = mkdtempSync(join(tmpdir(), "hyori-artifact-"));
  const root = join(parent, "output");

  directories.push(parent);
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "server/index.mjs"), "export {};");
  writeFileSync(join(root, "nitro.json"), "{}");

  return root;
}

describe("an artifact's portable identity", () => {
  test("is the same wherever the same bytes are", () => {
    const root = artifact();
    const elsewhere = join(artifact(), "..", "copy");

    cpSync(root, elsewhere, { recursive: true });

    expect(artifactDigest(elsewhere)).toBe(artifactDigest(root));
  });

  test("changes with any file's bytes", () => {
    const root = artifact();
    const before = artifactDigest(root);

    writeFileSync(join(root, "nitro.json"), "{ }");

    expect(artifactDigest(root)).not.toBe(before);
  });

  test("changes when a file only moves", () => {
    const root = artifact();
    const before = artifactDigest(root);

    rmSync(join(root, "nitro.json"));
    writeFileSync(join(root, "server/nitro.json"), "{}");

    expect(artifactDigest(root)).not.toBe(before);
  });
});

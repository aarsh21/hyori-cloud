import { expect, test } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { adoptionRoot, adoptedNoticeFiles } from "./content-adoption.ts";
import { contentDeliveryFiles } from "./content-delivery.ts";
import { acquireArtCraftFromArchives } from "./acquire.ts";
import {
  checkRuntimeBundle,
  createRuntimeBundle,
  runtimeManifestSchema,
} from "./content-runtime.ts";
import { sha256 } from "./evidence-bytes.ts";

const { ARTCRAFT_TEST_INPUTS: inputConfig } = z
  .object({ ARTCRAFT_TEST_INPUTS: z.string().optional() })
  .parse(process.env);

async function removeOwned(root: string) {
  await chmod(root, 0o755);

  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);

    if (stat.isDirectory() && !stat.isSymbolicLink()) await removeOwned(path);
  }

  await rm(root, { recursive: true, force: true });
}

test("adopted permissions remain complete original bytes and current data behavior remains unchanged", async () => {
  const files = await adoptedNoticeFiles();
  expect(files.size).toBe(26);
  expect([...files.keys()].filter((path) => path.endsWith(".afm")).length).toBe(14);
  const readme = files.get("legal/adopted-data/adobe-core14/readme.txt")!;
  expect(readme.toString()).toContain("with or without modification");
  expect(readme).toEqual(await readFile(join(adoptionRoot, "files/adobe-core14/readme.txt")));
  expect(files.get("legal/adopted-data/existing-source/encodings.rs.txt")).toEqual(
    await readFile(new URL("../../tooling/artcraft/pdfcraft-data-decision/1.txt", import.meta.url)),
  );
  const delivery = await contentDeliveryFiles();

  for (const [path, body] of files) expect(delivery.files.get(path)).toEqual(body);
  expect(delivery.files.size).toBe(173);
});

test("adoption rejects changed/missing permission and simultaneous catalog weakening", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyori-adoption-test-"));

  try {
    await cp(adoptionRoot, root, { recursive: true });
    const path = join(root, "files/adobe-core14/readme.txt");
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed")]));
    await expect(adoptedNoticeFiles(root)).rejects.toThrow("checksum mismatch");
    await rm(path);
    await expect(adoptedNoticeFiles(root)).rejects.toThrow();
    const index = await readFile(join(root, "index.json"), "utf8");
    await writeFile(
      join(root, "index.json"),
      index.replace("adobe-core14/readme.txt", "removed.txt"),
    );
    await expect(adoptedNoticeFiles(root)).rejects.toThrow("index pin mismatch");
  } finally {
    await removeOwned(root);
  }
});

test.skipIf(!inputConfig)(
  "runtime handoff is deterministic, readonly, exact official3 payloads plus required notices, never Deck .1",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hyori-runtime-test-"));

    try {
      const acquired = join(root, "acquired");
      await acquireArtCraftFromArchives(acquired, inputConfig!);
      const first = await createRuntimeBundle(join(root, "bundle-a"), acquired);
      const second = await createRuntimeBundle(join(root, "bundle-b"), acquired);
      expect(first.manifestSha256).toBe(second.manifestSha256);

      const manifest = runtimeManifestSchema.parse(
        JSON.parse(await readFile(first.manifest, "utf8")),
      );

      const bundle = join(root, "bundle-a");
      expect((await checkRuntimeBundle(bundle, first.manifestSha256)).verifiedFiles).toBe(2764);
      expect(manifest.editors.map((editor) => editor.app)).toEqual([
        "wordcraft",
        "gridcraft",
        "pdfcraft",
      ]);
      expect(manifest.editors.map((editor) => editor.files.length)).toEqual([26, 13, 11]);
      expect(manifest.assets.some((asset) => asset.path.startsWith("deckcraft/"))).toBe(false);
      expect(
        manifest.readiness.find((app) => app.app === "deckcraft")!.substantiveDistributionBlockers
          .length,
      ).toBe(3);
      expect(
        manifest.readiness
          .filter((app) => app.app !== "deckcraft")
          .every((app) => app.substantiveDistributionBlockers.length === 0),
      ).toBe(true);
      expect(manifest.allFourLaunchReady).toBe(false);
      expect(manifest.legalOpinion).toBe(false);
      expect(manifest.fullNoticeAuditComplete).toBe(false);
      expect(manifest.assets.find((asset) => asset.path.endsWith("_bg.wasm"))!.contentType).toBe(
        "application/wasm",
      );
      expect(manifest.assets.find((asset) => asset.path.endsWith("index.html"))!.cacheControl).toBe(
        "no-cache",
      );
      expect(manifest.assets.find((asset) => asset.path.endsWith("inline0.js"))!.cacheControl).toBe(
        "no-cache",
      );
      expect((await lstat(bundle)).mode & 0o777).toBe(0o555);
      expect((await lstat(first.manifest)).mode & 0o777).toBe(0o444);
      await expect(createRuntimeBundle(bundle, acquired)).rejects.toThrow("overwrite");
    } finally {
      await removeOwned(root);
    }
  },
  120000,
);

test.skipIf(!inputConfig)(
  "runtime gate rejects tampering, missing notices, weakened receipts, wrong URLs, writable modes and extra payload",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hyori-runtime-negative-"));

    try {
      const acquired = join(root, "acquired");
      const bundle = join(root, "bundle");
      await acquireArtCraftFromArchives(acquired, inputConfig!);
      const result = await createRuntimeBundle(bundle, acquired);
      const manifestBytes = await readFile(result.manifest);
      const manifest = runtimeManifestSchema.parse(JSON.parse(manifestBytes.toString()));
      const noticePath = "legal/adopted-data/adobe-core14/readme.txt";
      const notice = join(bundle, noticePath);
      const original = await readFile(notice);
      await chmod(notice, 0o644);
      await expect(checkRuntimeBundle(bundle, result.manifestSha256)).rejects.toThrow("mode");
      await writeFile(notice, Buffer.concat([original, Buffer.from("changed")]));
      await chmod(notice, 0o444);
      await expect(checkRuntimeBundle(bundle, result.manifestSha256)).rejects.toThrow(
        "bytes changed",
      );
      await chmod(join(bundle, "legal/adopted-data/adobe-core14"), 0o755);
      await rm(notice);
      await chmod(join(bundle, "legal/adopted-data/adobe-core14"), 0o555);
      await expect(checkRuntimeBundle(bundle, result.manifestSha256)).rejects.toThrow();
      await chmod(result.manifest, 0o644);

      const removed = Buffer.from(
        JSON.stringify({
          ...manifest,
          assets: manifest.assets.filter((asset) => asset.path !== noticePath),
        }),
      );

      await writeFile(result.manifest, removed);
      await chmod(result.manifest, 0o444);
      await expect(checkRuntimeBundle(bundle, sha256(removed))).rejects.toThrow(
        "coverage mismatch",
      );
      await chmod(join(bundle, "legal/adopted-data/adobe-core14"), 0o755);
      await writeFile(notice, original, { mode: 0o444 });
      await chmod(join(bundle, "legal/adopted-data/adobe-core14"), 0o555);

      const wrongUrl = Buffer.from(
        JSON.stringify({
          ...manifest,
          editors: manifest.editors.map((editor, index) =>
            index === 0 ? { ...editor, assetUrl: "https://untrusted.invalid/" } : editor,
          ),
        }),
      );

      await chmod(result.manifest, 0o644);
      await writeFile(result.manifest, wrongUrl);
      await chmod(result.manifest, 0o444);
      await expect(checkRuntimeBundle(bundle, sha256(wrongUrl))).rejects.toThrow("editor contract");
      await chmod(result.manifest, 0o644);
      await writeFile(result.manifest, manifestBytes);
      await chmod(result.manifest, 0o444);
      await expect(checkRuntimeBundle(bundle, "0".repeat(64))).rejects.toThrow("pin mismatch");
      await chmod(bundle, 0o755);
      await mkdir(join(bundle, "deckcraft"), { mode: 0o555 });
      await chmod(bundle, 0o555);
      // An empty unlisted directory must not provide a hole for later executable payloads.
      await chmod(join(bundle, "deckcraft"), 0o755);
      await writeFile(join(bundle, "deckcraft/blocked.js"), "blocked", { mode: 0o444 });
      await chmod(join(bundle, "deckcraft"), 0o555);
      await expect(checkRuntimeBundle(bundle, result.manifestSha256)).rejects.toThrow(
        "Unaccounted",
      );
    } finally {
      await removeOwned(root);
    }
  },
  120000,
);

// A stale pre-adoption acquisition cannot silently become a deployable runtime bundle.
test.skipIf(!inputConfig)(
  "runtime assembly refuses absent adopted bytes and cleans only its owned staging",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hyori-runtime-rollback-"));

    try {
      const acquired = join(root, "acquired");
      await acquireArtCraftFromArchives(acquired, inputConfig!);
      const notice = join(acquired, "legal/adopted-data/adobe-core14/readme.txt");
      await readFile(notice);
      await rm(notice);
      await expect(createRuntimeBundle(join(root, "bundle"), acquired)).rejects.toThrow();
      expect((await readdir(root)).sort()).toEqual(["acquired"]);
    } finally {
      await removeOwned(root);
    }
  },
  120000,
);

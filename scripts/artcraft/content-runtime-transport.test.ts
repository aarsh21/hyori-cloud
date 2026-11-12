import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import baseAuthority from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };
import {
  checkRuntimeBundle,
  runtimeManifestName,
  runtimeManifestSchema,
} from "./content-runtime.ts";
import {
  checkRuntimeTransportBundle,
  compressionManifestSchema,
  createRuntimeTransportBundle,
} from "./content-runtime-transport.ts";
import { sha256 } from "./evidence-bytes.ts";
import { createGzipTransportSidecar } from "./transport-sidecars.ts";

const inputs = z.object({ ARTCRAFT_TEST_TRANSPORT_BASE: z.string().optional() }).parse(process.env);

type ManifestAttack = z.infer<ReturnType<typeof z.json>>;

async function removeOwned(root: string) {
  await chmod(root, 0o755);

  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);

    if (stat.isDirectory() && !stat.isSymbolicLink()) await removeOwned(path);
  }

  await rm(root, { recursive: true, force: true });
}

async function replaceOwned(path: string, bytes: Buffer) {
  await chmod(path, 0o644);
  await writeFile(path, bytes);
  await chmod(path, 0o444);
}

test("transport assembly refuses existing destinations and all immutable-base descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyori-transport-no-overwrite-"));

  try {
    const existing = join(root, "existing");
    await writeFile(existing, "retained");
    await expect(
      createRuntimeTransportBundle(existing, join(root, "missing-base")),
    ).rejects.toThrow("overwrite");
    expect(await readFile(existing, "utf8")).toBe("retained");
    await expect(createRuntimeTransportBundle(root, root)).rejects.toThrow("separate");
    await expect(createRuntimeTransportBundle(join(root, "child"), root)).rejects.toThrow(
      "separate",
    );
    await expect(lstat(join(root, "child"))).rejects.toThrow();
  } finally {
    await removeOwned(root);
  }
});

test.skipIf(!inputs.ARTCRAFT_TEST_TRANSPORT_BASE)(
  "actual bb6-derived transport preserves every original and rejects semantic, inventory, mode and gzip attacks",
  async () => {
    const base = inputs.ARTCRAFT_TEST_TRANSPORT_BASE!;
    const root = await mkdtemp(join(tmpdir(), "hyori-transport-adversarial-"));

    try {
      const bundle = join(root, "bundle");
      const result = await createRuntimeTransportBundle(bundle, base);
      const manifestPath = join(bundle, runtimeManifestName);
      const originalBytes = await readFile(manifestPath);
      const manifest = compressionManifestSchema.parse(JSON.parse(originalBytes.toString()));
      const originalBaseBytes = await readFile(join(base, runtimeManifestName));
      const baseManifest = runtimeManifestSchema.parse(JSON.parse(originalBaseBytes.toString()));
      const baseInventory = new Map(baseManifest.assets.map((asset) => [asset.path, asset]));

      expect(result.baseManifestSha256).toBe(baseAuthority.manifestSha256);
      expect(result.assetFiles).toBe(baseAuthority.assetFiles + 8);
      expect(result.assetBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
      expect(manifest.transportSidecars.length).toBe(8);
      expect(manifest.editors.every((editor) => editor.role === "current")).toBe(true);
      expect(manifest.editors.map(({ role: _role, ...editor }) => editor)).toEqual(
        baseManifest.editors,
      );
      expect(manifest.assets.slice(0, baseAuthority.assetFiles)).toEqual(baseManifest.assets);
      expect(manifest.notices).toEqual(baseManifest.notices);
      expect(manifest.productIntegrationVerified).toBe(false);
      expect(manifest.allFourLaunchReady).toBe(false);
      expect(manifest.legalOpinion).toBe(false);
      expect((await lstat(bundle)).mode & 0o777).toBe(0o555);

      for (const asset of baseManifest.assets) {
        expect(sha256(await readFile(join(bundle, asset.path)))).toBe(asset.sha256);
        expect((await lstat(join(bundle, asset.path))).mode & 0o777).toBe(0o444);
      }

      for (const sidecar of manifest.transportSidecars) {
        const source = baseInventory.get(sidecar.original.path);

        expect(source).toBeDefined();
        expect(sidecar.path).toBe(`${sidecar.original.path}.gz`);
        expect(sidecar.original.path.split("/").length).toBe(3);
        expect(
          manifest.editors.some((editor) =>
            editor.files.some((file) => file.path === sidecar.path),
          ),
        ).toBe(false);
      }

      async function rejectManifest(value: ManifestAttack) {
        const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        await replaceOwned(manifestPath, bytes);

        try {
          await expect(checkRuntimeTransportBundle(bundle, sha256(bytes), base)).rejects.toThrow();
        } finally {
          await replaceOwned(manifestPath, originalBytes);
        }
      }

      await expect(checkRuntimeTransportBundle(bundle, "0".repeat(64), base)).rejects.toThrow(
        "pin mismatch",
      );
      await rejectManifest({ ...manifest, schemaVersion: 1 });
      await rejectManifest({ ...manifest, productIntegrationVerified: true });
      await rejectManifest({ ...manifest, legalOpinion: true });
      await rejectManifest({ ...manifest, allFourLaunchReady: true });
      await rejectManifest({ ...manifest, unknownAuthority: "invented" });
      await rejectManifest({
        ...manifest,
        editors: manifest.editors.map((editor) => ({ ...editor, role: "legacy" })),
      });
      await rejectManifest({
        ...manifest,
        editors: manifest.editors.map((editor) => ({ ...editor, protocol: 2 })),
      });
      await rejectManifest({ ...manifest, transportSidecars: manifest.transportSidecars.slice(1) });
      await rejectManifest({
        ...manifest,
        transportSidecars: manifest.transportSidecars.map((sidecar) => ({
          ...sidecar,
          bytes: 128 * 1024 * 1024,
        })),
        assets: manifest.assets.map((asset) =>
          asset.path.endsWith(".gz") ? { ...asset, bytes: 128 * 1024 * 1024 } : asset,
        ),
      });
      await rejectManifest({ ...manifest, assets: manifest.assets.slice(1) });
      await rejectManifest({ ...manifest, assets: [...manifest.assets, manifest.assets[0]!] });
      await rejectManifest({
        ...manifest,
        assets: Array.from({ length: 10001 }, () => manifest.assets[0]!),
      });
      await rejectManifest({
        ...manifest,
        assets: manifest.assets.map((asset) => ({ ...asset, bytes: 128 * 1024 * 1024 })),
      });
      await rejectManifest({
        ...manifest,
        assets: manifest.assets.map((asset) => ({ ...asset, path: `../${asset.path}` })),
      });
      await rejectManifest({
        ...manifest,
        assets: manifest.assets.map((asset) => ({ ...asset, contentType: "text/plain" })),
      });
      await rejectManifest({
        ...manifest,
        editors: manifest.editors.map((editor) => ({ ...editor, files: [] })),
      });
      await rejectManifest({
        ...manifest,
        notices: { ...manifest.notices, index: "legal/changed.md" },
      });
      await rejectManifest({
        ...manifest,
        transportSidecars: manifest.transportSidecars.map((sidecar) => ({
          ...sidecar,
          original: { ...sidecar.original, sha256: "0".repeat(64) },
        })),
      });

      const sidecar = manifest.transportSidecars[0]!;
      const gzipPath = join(bundle, sidecar.path);
      const gzipBytes = await readFile(gzipPath);
      const wrongRaw = Buffer.alloc(sidecar.original.bytes, 120);

      const wrong = createGzipTransportSidecar(
        { ...sidecar.original, sha256: sha256(wrongRaw) },
        wrongRaw,
      ).bytes;

      for (const changed of [
        Buffer.concat([gzipBytes, gzipSync(Buffer.alloc(0))]),
        Buffer.concat([gzipBytes, Buffer.from([0])]),
        wrong,
      ]) {
        await replaceOwned(gzipPath, changed);

        try {
          await rejectManifest({
            ...manifest,
            assets: manifest.assets.map((asset) =>
              asset.path === sidecar.path
                ? { ...asset, bytes: changed.length, sha256: sha256(changed) }
                : asset,
            ),
            transportSidecars: manifest.transportSidecars.map((entry) =>
              entry.path === sidecar.path
                ? { ...entry, bytes: changed.length, sha256: sha256(changed) }
                : entry,
            ),
          });
        } finally {
          await replaceOwned(gzipPath, gzipBytes);
        }
      }

      await chmod(gzipPath, 0o644);
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("mode");
      await chmod(gzipPath, 0o444);
      await replaceOwned(
        gzipPath,
        Buffer.concat([
          gzipBytes.subarray(0, -1),
          Buffer.from([gzipBytes[gzipBytes.length - 1]! ^ 1]),
        ]),
      );
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("identity");
      await replaceOwned(gzipPath, gzipBytes);

      const noticePath = join(bundle, "legal/RUNTIME-NOTICE-INDEX.md");
      const noticeBytes = await readFile(noticePath);
      await replaceOwned(noticePath, Buffer.alloc(noticeBytes.length, 32));
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("identity");
      await replaceOwned(noticePath, noticeBytes);

      await chmod(bundle, 0o755);
      await writeFile(join(bundle, "unlisted.js"), "unlisted", { mode: 0o444 });
      await chmod(bundle, 0o555);
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("unlisted");
      await chmod(bundle, 0o755);
      await rm(join(bundle, "unlisted.js"));
      await mkdir(join(bundle, "unlisted-directory"), { mode: 0o555 });
      await chmod(bundle, 0o555);
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("unlisted");
      await chmod(bundle, 0o755);
      await rm(join(bundle, "unlisted-directory"), { recursive: true });
      await chmod(bundle, 0o555);

      await chmod(dirname(gzipPath), 0o755);
      await rm(gzipPath);
      await symlink(join(base, sidecar.original.path), gzipPath);
      await chmod(dirname(gzipPath), 0o555);
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("symlink");
      await chmod(dirname(gzipPath), 0o755);
      await rm(gzipPath);
      await chmod(dirname(gzipPath), 0o555);
      await expect(
        checkRuntimeTransportBundle(bundle, result.manifestSha256, base),
      ).rejects.toThrow("coverage");
      await chmod(dirname(gzipPath), 0o755);
      await writeFile(gzipPath, gzipBytes, { mode: 0o444 });
      await chmod(dirname(gzipPath), 0o555);

      expect(
        (await checkRuntimeTransportBundle(bundle, result.manifestSha256, base)).assetFiles,
      ).toBe(result.assetFiles);
      expect(await readFile(join(base, runtimeManifestName))).toEqual(originalBaseBytes);
      expect((await checkRuntimeBundle(base, baseAuthority.manifestSha256)).verifiedFiles).toBe(
        baseAuthority.assetFiles,
      );
    } finally {
      await removeOwned(root);
    }
  },
  300000,
);

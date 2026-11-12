import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const versions = [
  ["wordcraft", "0.14.0"],
  ["gridcraft", "0.15.0"],
  ["deckcraft", "0.14.1-hyori-host.2"],
  ["pdfcraft", "0.17.0"],
] as const;

async function permissions(path: string, writable: boolean): Promise<void> {
  const directory = (await lstat(path)).isDirectory();
  await chmod(path, directory ? (writable ? 0o755 : 0o555) : writable ? 0o644 : 0o444);

  if (directory)
    for (const name of await readdir(path)) await permissions(join(path, name), writable);
}

/** Non-executable, dev/loopback-only inventory for SDK persistence tests, not vendor acceptance. */
export async function createSyntheticEditorAssets() {
  const directory = await mkdtemp(join(tmpdir(), "hyori-editor-sdk-assets-"));

  const dispose = async () => {
    await permissions(directory, true);
    await rm(directory, { recursive: true });
  };

  try {
    const record = async (path: string, content: string) => {
      const bytes = Buffer.from(content);
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);

      return {
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };

    const editors = [];
    const assets = [];

    for (const [app, version] of versions) {
      const index = `${app}/${version}/index.html`;

      const file = await record(
        index,
        "<!doctype html><title>Non-vendor persistence fixture; no editor runtime</title>",
      );

      assets.push({ ...file, contentType: "text/html; charset=utf-8", cacheControl: "no-store" });
      editors.push({
        app,
        version,
        archiveSha256: "0".repeat(64),
        index,
        assetUrl: `/artcraft/${index}?host=parent`,
        bridge: app === "deckcraft" ? "hyori-correlated-host-v1" : "upstream-host-parent",
        deployable: true,
        files: [file],
      });
    }

    const notice = await record(
      "legal/RUNTIME-NOTICE-INDEX.md",
      "Synthetic non-vendor fixture. No executable editor assets or legal clearance.\n",
    );

    assets.push({ ...notice, contentType: "text/plain; charset=utf-8", cacheControl: "no-store" });

    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: "artcraft-runtime-static-bundle",
        purpose: "synthetic-persistence-test",
        mountPath: "/artcraft",
        deploymentScope: "verified-static-assets-only-not-product-launch-or-legal-clearance",
        deployable: true,
        legalOpinion: false,
        productIntegrationVerified: false,
        allFourLaunchReady: false,
        editors,
        assets,
      }),
    );

    await writeFile(join(directory, "runtime-bundle-manifest.json"), manifest);
    await permissions(directory, false);

    return {
      directory,
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

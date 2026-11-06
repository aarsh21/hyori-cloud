import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSyntheticEditorAssets } from "./editor-assets-fixture.ts";

test("SDK fixture is pinned, read-only and explicitly synthetic, and cleans only its own directory", async () => {
  const fixture = await createSyntheticEditorAssets();

  try {
    const bytes = await readFile(join(fixture.directory, "runtime-bundle-manifest.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.manifestSha256);
    expect(bytes.toString()).toContain('"purpose":"synthetic-persistence-test"');
    expect(bytes.toString()).toContain('"productIntegrationVerified":false');
    expect(bytes.toString()).toContain('"allFourLaunchReady":false');
    expect(bytes.toString()).toContain('"version":"0.14.1-hyori-host.2"');
    let files = 0;

    const inspect = async (path: string): Promise<void> => {
      const metadata = await lstat(path);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o222).toBe(0);

      if (metadata.isDirectory())
        for (const name of await readdir(path)) await inspect(join(path, name));
      else files += 1;
    };

    await inspect(fixture.directory);
    expect(files).toBe(6);
  } finally {
    await fixture.dispose();
  }

  expect(await Bun.file(join(fixture.directory, "runtime-bundle-manifest.json")).exists()).toBe(
    false,
  );
});

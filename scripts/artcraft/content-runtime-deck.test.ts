import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { acquireArtCraftFromArchives } from "./acquire.ts";
import {
  checkRuntimeBundle,
  createRuntimeBundle,
  runtimeManifestSchema,
} from "./content-runtime.ts";
import { markedDeckRuntime } from "./content-runtime-deck.ts";
import { markedDeckPayloadHash, markedDeckVersion } from "./deckcraft-artifact-identity.ts";
import { sha256 } from "./evidence-bytes.ts";

const inputs = z
  .object({
    ARTCRAFT_TEST_INPUTS: z.string().optional(),
    ARTCRAFT_TEST_MARKED_DECK_EVIDENCE: z.string().optional(),
  })
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

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS || !inputs.ARTCRAFT_TEST_MARKED_DECK_EVIDENCE)(
  "all-four static bundle pins actual final marked Deck and corresponding modified source/notices without claiming launch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hyori-all4-runtime-"));

    try {
      const acquired = join(root, "acquired");
      const bundle = join(root, "bundle");
      await acquireArtCraftFromArchives(acquired, inputs.ARTCRAFT_TEST_INPUTS!);

      const result = await createRuntimeBundle(
        bundle,
        acquired,
        inputs.ARTCRAFT_TEST_MARKED_DECK_EVIDENCE!,
      );

      const manifest = runtimeManifestSchema.parse(
        JSON.parse(await readFile(result.manifest, "utf8")),
      );

      const marked = await markedDeckRuntime();
      const deck = manifest.editors.find((editor) => editor.app === "deckcraft");

      if (!deck || deck.bridge !== "hyori-correlated-host-v1")
        throw new Error("Actual .2 editor was not composed");
      expect(deck.version).toBe(markedDeckVersion);
      expect(deck.assetUrl).toBe(`/artcraft/deckcraft/${markedDeckVersion}/index.html?host=parent`);
      expect(deck.payloadSha256).toBe(markedDeckPayloadHash(deck.files));
      expect(deck.buildManifestSha256).toBe(marked.authority.buildManifestSha256);
      expect(manifest.editors.length).toBe(4);
      expect(
        manifest.readiness.every((editor) => editor.substantiveDistributionBlockers.length === 0),
      ).toBe(true);
      expect(manifest.allFourLaunchReady).toBe(false);
      expect(manifest.productIntegrationVerified).toBe(false);
      expect(manifest.legalOpinion).toBe(false);
      expect(manifest.assets.some((asset) => asset.path.includes("0.14.1-hyori-host.1/"))).toBe(
        false,
      );

      for (const file of deck.files) {
        const body = await readFile(join(bundle, file.path));
        expect(body.length).toBe(file.bytes);
        expect(sha256(body)).toBe(file.sha256);
      }

      expect(
        manifest.assets.filter((asset) =>
          asset.path.startsWith("legal/deckcraft-host-v2/modified-source/"),
        ).length,
      ).toBe(23);
      expect((await checkRuntimeBundle(bundle, result.manifestSha256)).editors.length).toBe(4);
      const receipt = join(bundle, "legal/deckcraft-host-v2/receipt.json");
      const original = await readFile(receipt);
      await chmod(receipt, 0o644);
      await writeFile(receipt, Buffer.concat([original, Buffer.from("changed")]));
      await chmod(receipt, 0o444);
      await expect(checkRuntimeBundle(bundle, result.manifestSha256)).rejects.toThrow(
        "bytes changed",
      );
    } finally {
      await removeOwned(root);
    }
  },
  120000,
);

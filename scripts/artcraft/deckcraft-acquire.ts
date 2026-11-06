import { mkdir, mkdtemp, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { checkDeckCraftRun, deckRunRoot } from "./deckcraft-run.ts";
import {
  assertAuditedAsset,
  contentDeliveryFiles,
  readAcquisitionFile,
} from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const buildSchema = z.object({
  artifactVersion: z.literal("0.14.1-hyori-host.1"),
  deployable: z.literal(false),
  assets: z.array(
    z.object({ path: relativePath, bytes: z.number().int().nonnegative(), sha256: digest }),
  ),
});

/** Assemble existing retained build outputs only; never rebuild, download, or publish them. */
export async function acquireRetainedDeckCraft(destination: string, evidenceDirectory: string) {
  const output = resolve(destination);

  try {
    await lstat(output);
    throw new Error(`Refusing to overwrite existing modified Deck output: ${output}`);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  await checkDeckCraftRun();
  const buildBytes = await readFile(join(deckRunRoot, "build-manifest.json"));
  const build = buildSchema.parse(JSON.parse(buildBytes.toString()));
  const delivery = await contentDeliveryFiles();
  const inputs = build.assets.filter((asset) => asset.path.startsWith("artifact/"));

  if (new Set(inputs.map((file) => file.path)).size !== inputs.length)
    throw new Error("Duplicate modified artifact member");

  const expectedPayload = delivery.discovered.assets.filter(
    (asset) => asset.artifact === "deckcraft@0.14.1-hyori-host.1",
  );

  if (
    inputs.filter((file) => !file.path.startsWith("artifact/legal/")).length !==
    expectedPayload.length
  )
    throw new Error("Modified build payload differs from content audit");
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".deckcraft-acquire-"));
  const assets: { path: string; bytes: number; sha256: string }[] = [];

  async function install(path: string, body: Buffer) {
    await mkdir(dirname(join(temporary, path)), { recursive: true });
    await writeFile(join(temporary, path), body, { flag: "wx" });
    assets.push({ path, bytes: body.length, sha256: sha256(body) });
  }

  try {
    for (const input of inputs) {
      const body = await readAcquisitionFile(resolve(evidenceDirectory), input.path);

      if (body.length !== input.bytes || sha256(body) !== input.sha256)
        throw new Error(`Modified build output checksum mismatch: ${input.path}`);
      const path = input.path.slice("artifact/".length);

      if (!path.startsWith("legal/"))
        assertAuditedAsset(delivery.discovered, "deckcraft@0.14.1-hyori-host.1", path, body);
      await install(path, body);
    }

    for (const [path, body] of delivery.files) await install(path, body);
    // Preserve the historical build receipt verbatim, separately from this new assembly receipt.
    await install("legal/RETAINED-BUILD-MANIFEST.json", buildBytes);

    const manifest = {
      schemaVersion: 1,
      kind: "retained-modified-deck-local-acquisition",
      artifactVersion: build.artifactVersion,
      deployable: false,
      officialReleaseReplaced: false,
      retainedBuildManifestSha256: sha256(buildBytes),
      redistribution: {
        localNoticeIndex: "legal/NOTICE-INDEX.md",
        contentNoticeManifest: "legal/content/notice-manifest.json",
        contentCoverage: "legal/content-coverage.json",
        contentSupplementIndexSha256: delivery.indexSha256,
        localNoticeDeliveryVerified: true,
        runtimePublication: false,
        fullNoticeAuditComplete: false,
        compilerGeneratedNoticeAuditComplete: false,
        protectedMarksCleared: false,
        legalOpinion: false,
      },
      assets: assets.sort((a, b) => a.path.localeCompare(b.path, "en")),
    };

    await writeFile(
      join(temporary, "artifact-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(temporary, output);

    return join(output, "artifact-manifest.json");
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}

if (import.meta.main) {
  const [, , destination, evidence] = process.argv;

  if (!destination || !evidence || process.argv.length !== 4)
    throw new Error(
      "Usage: bun scripts/artcraft/deckcraft-acquire.ts NEW_OUTPUT EXISTING_BUILD_EVIDENCE",
    );
  console.log(await acquireRetainedDeckCraft(destination, evidence));
}

import { z } from "zod";
import {
  contentDeliveryFiles,
  readAcquisitionFile,
  noticeIndexSha256,
} from "./content-delivery.ts";
import { relativePath, digest } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const receiptSchema = z.object({
  deployable: z.literal(false),
  redistribution: z.object({
    localNoticeIndex: z.literal("legal/NOTICE-INDEX.md"),
    contentNoticeManifest: z.literal("legal/content/notice-manifest.json"),
    contentCoverage: z.literal("legal/content-coverage.json"),
    contentSupplementIndexSha256: z.literal(noticeIndexSha256),
    localNoticeDeliveryVerified: z.literal(true),
    runtimePublication: z.literal(false),
    fullNoticeAuditComplete: z.literal(false),
    compilerGeneratedNoticeAuditComplete: z.literal(false),
    protectedMarksCleared: z.literal(false),
    legalOpinion: z.literal(false),
  }),
  assets: z.array(
    z.object({ path: relativePath, bytes: z.number().int().nonnegative(), sha256: digest }),
  ),
});

/** Independently check local installed notice bytes, including removal of both bytes and receipt row. */
export async function checkAcquiredNotices(root: string) {
  const receipt = receiptSchema.parse(
    JSON.parse((await readAcquisitionFile(root, "artifact-manifest.json")).toString()),
  );

  if (new Set(receipt.assets.map((asset) => asset.path)).size !== receipt.assets.length)
    throw new Error("Duplicate acquired asset receipt");
  const delivery = await contentDeliveryFiles();

  for (const [path, expected] of delivery.files) {
    const record = receipt.assets.find((asset) => asset.path === path);

    if (!record || record.bytes !== expected.length || record.sha256 !== sha256(expected))
      throw new Error(`Acquired notice receipt missing or changed: ${path}`);
    const body = await readAcquisitionFile(root, path);

    if (!body.equals(expected)) throw new Error(`Acquired notice bytes changed: ${path}`);
  }

  return { verifiedNoticeFiles: delivery.files.size, deployable: false, runtimePublication: false };
}

if (import.meta.main) {
  const [, , root] = process.argv;

  if (!root || process.argv.length !== 3)
    throw new Error("Usage: bun scripts/artcraft/content-acquired.ts LOCAL_ACQUISITION");
  console.log(JSON.stringify(await checkAcquiredNotices(root), null, 2));
}

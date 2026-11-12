import { z } from "zod";
import { readAcquisitionFile } from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

export const markedDeckVersion = "0.14.1-hyori-host.2";

const file = z.object({
  path: relativePath,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  sha256: digest,
});

export const markedDeckReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("marked-modified-deck-static-receipt"),
  artifactVersion: z.literal(markedDeckVersion),
  sourceArchiveSha256: z.literal(
    "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7",
  ),
  buildManifestSha256: digest,
  payloadSha256: digest,
  sourceSummarySha256: digest,
  files: z.array(file).length(6),
  proof: z.object({
    isolatedOfflineLockedWasmBuild: z.literal(true),
    exactSourceReplayVerified: z.literal(true),
    sourceMarksReplacementVerified: z.literal(true),
    originalFontNoticeInputsUnchanged: z.literal(true),
    legalOpinion: z.literal(false),
    actualSdkBackendIntegration: z.literal(false),
    realBrowserWasmRoundTrip: z.literal(false),
    allFourLaunchReady: z.literal(false),
  }),
});

export function markedDeckPayloadHash(files: z.infer<typeof file>[]) {
  const normalized = files
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (new Set(normalized.map((file) => file.path)).size !== normalized.length)
    throw new Error("Duplicate marked Deck payload path");

  for (const file of normalized)
    if (!file.path.startsWith(`deckcraft/${markedDeckVersion}/`) || file.path.includes("/legal/"))
      throw new Error("Marked Deck payload path/namespace mismatch");

  return sha256(Buffer.from(JSON.stringify(normalized)));
}

/** Caller must supply the independently adopted exact receipt pin, never a self-claimed hash. */
export async function checkMarkedDeckIdentity(root: string, receiptSha256: string) {
  digest.parse(receiptSha256);
  const bytes = await readAcquisitionFile(root, "receipt.json");

  if (sha256(bytes) !== receiptSha256) throw new Error("Marked Deck receipt pin mismatch");
  const receipt = markedDeckReceiptSchema.parse(JSON.parse(bytes.toString()));

  if (markedDeckPayloadHash(receipt.files) !== receipt.payloadSha256)
    throw new Error("Marked Deck canonical payload mismatch");

  if (
    sha256(await readAcquisitionFile(root, "build-manifest.json")) !== receipt.buildManifestSha256
  )
    throw new Error("Marked Deck build receipt changed");

  if (
    sha256(await readAcquisitionFile(root, "source-summary.json")) !== receipt.sourceSummarySha256
  )
    throw new Error("Marked Deck complete source summary changed");

  return { receipt, receiptBytes: bytes };
}

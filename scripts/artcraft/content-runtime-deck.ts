import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkMarkedDeckIdentity, markedDeckVersion } from "./deckcraft-artifact-identity.ts";
import { readAcquisitionFile } from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const toolingRoot = fileURLToPath(new URL("../../tooling/artcraft/", import.meta.url));

const authoritySchema = z.object({
  schemaVersion: z.literal(1),
  artifactVersion: z.literal(markedDeckVersion),
  sourceArchiveSha256: z.literal(
    "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7",
  ),
  buildManifestSha256: digest,
  payloadSha256: digest,
  receiptSha256: digest,
  sourceSummarySha256: digest,
  receiptRoot: relativePath,
  sourceSummary: relativePath,
});

const record = z.object({
  path: relativePath,
  bytes: z.number().int().nonnegative(),
  sha256: digest,
});

const buildSchema = z.object({
  artifactVersion: z.literal(markedDeckVersion),
  assets: z.array(record),
});

/** One retained public authority supplies backend and static producer identities without duplicate pins. */
export async function markedDeckRuntime() {
  const authorityBytes = await readFile(join(toolingRoot, "runtime-deckcraft-v2.json"));
  const authority = authoritySchema.parse(JSON.parse(authorityBytes.toString()));

  if (authority.sourceSummary !== `${authority.receiptRoot}/source-summary.json`)
    throw new Error("Marked source-summary authority path differs from retained receipt");
  const receiptRoot = join(toolingRoot, authority.receiptRoot);

  const { receipt, receiptBytes } = await checkMarkedDeckIdentity(
    receiptRoot,
    authority.receiptSha256,
  );

  if (
    receipt.sourceArchiveSha256 !== authority.sourceArchiveSha256 ||
    receipt.buildManifestSha256 !== authority.buildManifestSha256 ||
    receipt.payloadSha256 !== authority.payloadSha256 ||
    receipt.sourceSummarySha256 !== authority.sourceSummarySha256
  )
    throw new Error("Marked runtime authority differs from complete build/source receipt");
  const buildBytes = await readAcquisitionFile(receiptRoot, "build-manifest.json");
  const build = buildSchema.parse(JSON.parse(buildBytes.toString()));
  const index = `deckcraft/${markedDeckVersion}/index.html`;

  const editor = {
    app: "deckcraft" as const,
    version: markedDeckVersion,
    sourceArchiveSha256: receipt.sourceArchiveSha256,
    buildManifestSha256: receipt.buildManifestSha256,
    payloadSha256: receipt.payloadSha256,
    index,
    assetUrl: `/artcraft/${index}?host=parent`,
    bridge: "hyori-correlated-host-v1" as const,
    deployable: true as const,
    files: receipt.files,
  };

  const records = new Map<string, { bytes: number; sha256: string; evidencePath: string | null }>();
  const generated = new Map<string, Buffer>();

  for (const file of receipt.files)
    records.set(file.path, {
      bytes: file.bytes,
      sha256: file.sha256,
      evidencePath: `artifact/${file.path.slice(`deckcraft/${markedDeckVersion}/`.length)}`,
    });

  for (const file of build.assets) {
    if (!file.path.startsWith("artifact/legal/") && !file.path.startsWith("modified-source/"))
      continue;
    const path = `legal/deckcraft-host-v2/${file.path}`;
    records.set(path, { bytes: file.bytes, sha256: file.sha256, evidencePath: file.path });
  }

  for (const [name, body] of [
    ["build-manifest.json", buildBytes],
    ["receipt.json", receiptBytes],
    ["source-summary.json", await readAcquisitionFile(receiptRoot, "source-summary.json")],
    ["authority.json", authorityBytes],
  ] satisfies [string, Buffer][]) {
    const path = `legal/deckcraft-host-v2/${name}`;
    records.set(path, { bytes: body.length, sha256: sha256(body), evidencePath: null });
    generated.set(path, body);
  }

  const notice = Buffer.from(
    `# Hyori Presentations modified DeckCraft .2\n\nBased on DeckCraft by the ArtCraft team. This is a modified version, not an official ArtCraft product or endorsement. Original upstream LICENSE/NOTICE/ATTRIBUTION and exact dependency/font/compiler/data notices are preserved. Product marks were replaced by the frozen Opus source patch using existing Hyori inputs; protocol1 now permits explicit authorized read-only copy and defaults PPTX Ctrl+S to a native copy. Original source/tag reference, complete changed source files, hashes and source/compiled font witnesses accompany this distribution. See source-summary.json, receipt.json and build-manifest.json; the modified-source/ tree contains the complete changed source members. No modified Symphonia covered source is introduced; exact retained MPL matching-source references remain in artifact/legal/SYMPHONIA-SOURCES.md.\n\nThis is supported static redistribution composition, not legal opinion, full optimized-byte attribution or proof of real SDK/backend/browser acceptance. Synthetic .1 browser evidence is historical and not promoted to .2 integration evidence. All-four launch readiness remains false until the parent verifies the actual runtime lifecycle. Internal DeckCraft theme/format identifiers and plain upstream copyright attribution remain for compatibility/provenance, not modified-product branding.\n`,
  );

  const noticePath = "legal/deckcraft-host-v2/MODIFICATIONS.md";
  generated.set(noticePath, notice);
  records.set(noticePath, { bytes: notice.length, sha256: sha256(notice), evidencePath: null });

  return { authority, editor, records, generated };
}

export async function markedDeckRuntimeBytes(evidenceRoot: string) {
  const marked = await markedDeckRuntime();
  const files = new Map<string, Buffer>();

  for (const [path, record] of marked.records) {
    const bytes =
      marked.generated.get(path) ?? (await readAcquisitionFile(evidenceRoot, record.evidencePath!));

    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
      throw new Error(`Marked Deck runtime/evidence bytes changed: ${path}`);
    files.set(path, bytes);
  }

  return { ...marked, files };
}

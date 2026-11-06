import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import handoff from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };
import { discoverSfnt, inspectWasm } from "./content-binary.ts";
import {
  checkRuntimeBundle,
  runtimeManifestSchema,
  runtimeManifestName,
} from "./content-runtime.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , rootArgument, destination] = process.argv;

if (!rootArgument || !destination || process.argv.length !== 4)
  throw new Error("Usage: bun scripts/artcraft/engine-load-cost.ts EXISTING_RUNTIME NEW_REPORT");

const root = resolve(rootArgument);
const verified = await checkRuntimeBundle(root, handoff.manifestSha256);

const manifest = runtimeManifestSchema.parse(
  JSON.parse(await readFile(join(root, runtimeManifestName), "utf8")),
);

const editors = [];

for (const editor of manifest.editors) {
  const asset = editor.files.find((file) => file.path.endsWith(".wasm"));

  if (!asset) throw new Error(`No WASM member for ${editor.app}`);

  const bytes = await readFile(join(root, asset.path));

  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
    throw new Error(`WASM changed during analysis: ${asset.path}`);

  const inspected = inspectWasm(bytes);
  const fonts = discoverSfnt(inspected.memory);
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } });

  editors.push({
    app: editor.app,
    version: editor.version,
    path: asset.path,
    bytes: bytes.length,
    sha256: asset.sha256,
    gzipLevel6Bytes: gzipSync(bytes, { level: 6 }).length,
    brotliQuality6Bytes: compressed.length,
    codeSectionBytes: inspected.sections
      .filter((section) => section.id === 10)
      .reduce((sum, section) => sum + section.bytes, 0),
    dataSectionBytes: inspected.sections
      .filter((section) => section.id === 11)
      .reduce((sum, section) => sum + section.bytes, 0),
    customSections: inspected.sections.flatMap((section) =>
      section.id === 0 ? [{ name: section.name, bytes: section.bytes }] : [],
    ),
    sfntInstances: fonts.length,
    sfntInstanceBytes: fonts.reduce((sum, font) => sum + font.bytes, 0),
    sfntNotice:
      "Structurally recognized sfnt regions only; not all possible font formats or runtime font/atlas allocation. Instances may repeat.",
  });
}

const report = {
  schemaVersion: 1,
  kind: "static-wasm-load-cost-investigation",
  runtimeManifestSha256: verified.manifestSha256,
  vendorExecution: false,
  strippedOrCompressedArtifactsShipped: false,
  loadTimeMeasured: false,
  productionHttpEncodingMeasured: false,
  compressionParameters: { gzipLevel: 6, brotliQuality: 6 },
  editors,
};

await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

console.log(
  `Retained static load-cost report for ${editors.length} pinned WASM members; no speed claim.`,
);

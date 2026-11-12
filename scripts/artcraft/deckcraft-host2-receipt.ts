import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { patchDeckMarks } from "./deckcraft-marks.ts";
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { readAcquisitionFile } from "./content-delivery.ts";
import { checkContentAudit } from "./content-audit.ts";
import { discoverSfnt, inspectWasm } from "./content-binary.ts";
import { digest, relativePath } from "./content-schema.ts";

const record = z.object({
  path: relativePath,
  bytes: z.number().int().nonnegative(),
  sha256: digest,
});

const planSchema = z.object({
  artifactVersion: z.literal("0.14.1-hyori-host.2"),
  sourceCargoLockSha256: digest,
  files: z.array(record),
  patchedFiles: z.array(z.object({ path: relativePath, before: digest.nullable(), after: digest })),
});

const buildSchema = z.object({
  artifactVersion: z.literal("0.14.1-hyori-host.2"),
  assets: z.array(record),
  builtInputsSha256: digest,
  proof: z.object({ isolatedOfflineLockedWasmBuild: z.literal(true) }),
  graph: z.object({
    targetNormalPackages: z.literal(236),
    hostInclusivePackages: z.literal(264),
    targetFeaturesEqualRetainedDeckCraftGraph: z.literal(true),
  }),
});

const sourceArchiveSha256 = "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7";

const [, , stageArgument, evidenceArgument, sourceArchive, destination] = process.argv;

if (
  !stageArgument ||
  !evidenceArgument ||
  !sourceArchive ||
  !destination ||
  process.argv.length !== 6
)
  throw new Error(
    "Usage: bun scripts/artcraft/deckcraft-host2-receipt.ts COMPLETED_STAGE BUILD_EVIDENCE TAGGED_SOURCE_ARCHIVE NEW_RECEIPT",
  );

const stage = resolve(stageArgument);
const evidence = resolve(evidenceArgument);
const source = await readFile(sourceArchive);

if (sha256(source) !== sourceArchiveSha256) throw new Error(".2 original source pin mismatch");

const original = readGitSourceArchive(
  source,
  "deckcraft-0.14.1",
  "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
);

const planBytes = await readFile(join(stage, "build-inputs.json"));
const plan = planSchema.parse(JSON.parse(planBytes.toString()));

for (const input of plan.files) {
  const body = await readAcquisitionFile(join(stage, "input"), input.path);

  if (sha256(body) !== input.sha256 || body.length !== input.bytes)
    throw new Error(`.2 build input changed: ${input.path}`);
}

const finalSource = join(stage, "input/source");

const replayed = patchDeckMarks(
  patchDeckCraft(original, {
    hostRust: await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
    hostJavaScript: await readAcquisitionFile(finalSource, "apps/deckcraft-web/hyori-host.js"),
  }).files,
  {
    favicon: await readAcquisitionFile(finalSource, "apps/deckcraft-web/hyori-mark.ico"),
    icon: await readAcquisitionFile(finalSource, "assets/hyori-mark.png"),
  },
);

for (const [path, body] of replayed.files)
  if (!(await readAcquisitionFile(finalSource, path)).equals(body))
    throw new Error(`.2 exact patch replay differs: ${path}`);

const changes = [...replayed.files].flatMap(([path, body]) => {
  const before = original.get(path);

  return before?.equals(body)
    ? []
    : [{ path, before: before ? sha256(before) : null, after: sha256(body) }];
});

if (JSON.stringify(changes) !== JSON.stringify(plan.patchedFiles))
  throw new Error(".2 complete source delta receipt mismatch");

for (const path of [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "NOTICE",
  "ATTRIBUTION.md",
  "docs/brand/LICENSE-brand.txt",
])
  if (!replayed.files.get(path)!.equals(original.get(path)!))
    throw new Error(".2 upstream legal bytes changed");

const buildBytes = await readAcquisitionFile(evidence, "manifest.json");
const build = buildSchema.parse(JSON.parse(buildBytes.toString()));

if (
  build.builtInputsSha256 !== sha256(planBytes) ||
  sha256(replayed.files.get("Cargo.lock")!) !== plan.sourceCargoLockSha256
)
  throw new Error(".2 build/source lock identity mismatch");

for (const file of build.assets) {
  const bytes = await readAcquisitionFile(evidence, file.path);

  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error(`.2 retained build evidence changed: ${file.path}`);
}

const payload = build.assets.filter(
  (file) => file.path.startsWith("artifact/") && !file.path.startsWith("artifact/legal/"),
);

if (payload.length !== 6) throw new Error(".2 expected six raw browser members");

const html = payload.find((file) => file.path === "artifact/index.html")!;
const htmlBytes = await readAcquisitionFile(evidence, html.path);

if (
  !htmlBytes.toString().includes("<title>Hyori Presentations</title>") ||
  htmlBytes.toString().includes("deckcraft.ico")
)
  throw new Error(".2 product title/favicon source identity failed");

const favicon = payload.find((file) => file.path.endsWith(".ico"))!;

if (favicon.sha256 !== sha256(replayed.files.get("apps/deckcraft-web/hyori-mark.ico")!))
  throw new Error(".2 actual favicon differs from reused Hyori input");

const hostJs = payload.find((file) => file.path.endsWith("/hyori-host.js"));

if (!hostJs) throw new Error("Final compiled bridge snippet is missing");

if (hostJs.sha256 !== "cbaf952ff39f19859ee90cf04d7839eb4a7dc6bf61fbfc650b718c25e01be0c6")
  throw new Error("Final frozen .2 protocol JS differs from corrected Opus input");

const wasm = payload.find((file) => file.path.endsWith(".wasm"))!;
const memory = inspectWasm(await readAcquisitionFile(evidence, wasm.path)).memory;

if (
  !memory.includes(Buffer.from("0.14.1-hyori-host.2")) ||
  !memory.includes(Buffer.from("Hyori Presentations"))
)
  throw new Error(".2 compiled Rust version/product witness missing");

const { discovered } = await checkContentAudit();

const previous = discovered.binaries.find(
  (binary) => binary.artifact === "deckcraft@0.14.1-hyori-host.1",
)!;

const beforeFonts = previous.fonts.map((font) => font.sha256).sort();

const afterFonts = discoverSfnt(memory)
  .map((font) => font.sha256)
  .sort();

if (JSON.stringify(beforeFonts) !== JSON.stringify(afterFonts))
  throw new Error(".2 embedded font inputs differ; new notice review required");

const snippet = payload.find((file) => file.path.includes("snippets/eframe-"))!;

if (snippet.sha256 !== "22a98f9d0c5a0532d291bdc9a3050439420b3d11143b4568fcfd3c66fff36995")
  throw new Error(".2 shared eframe copied notice correspondence changed");

const files = payload
  .map((file) => ({
    path: `deckcraft/0.14.1-hyori-host.2/${file.path.slice("artifact/".length)}`,
    bytes: file.bytes,
    sha256: file.sha256,
  }))
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const output = resolve(destination);

await mkdir(dirname(output), { recursive: true });

await mkdir(output);

await writeFile(join(output, "build-manifest.json"), buildBytes, { flag: "wx" });

await writeFile(join(output, "build-inputs.json"), planBytes, { flag: "wx" });

await writeFile(
  join(output, "source-freeze.json"),
  await readAcquisitionFile(stage, "source-freeze.json"),
  { flag: "wx" },
);

const frozenSources: { path: string; bytes: number; sha256: string }[] = [];

for (const [path, hash] of [
  [
    "tooling/artcraft/patches/deckcraft-host-v2/host-protocol.ts",
    "f7bf019e06c1ed1e724619f280ae9a35d11821184c1f8c1d729cc43a3190f97b",
  ],
  [
    "tooling/artcraft/patches/deckcraft-host-v2/host-entry.ts",
    "fd1ab3faa1a5dbdcdbfa1e1798bff13f695c9d3c5f3664d30782b3fd6f804c49",
  ],
  [
    "scripts/artcraft/deckcraft-marks.ts",
    "66d5551183bd469f03b2a868091bbf706ab3f67ec62906c3e0d47314d3f729cd",
  ],
  [
    "scripts/artcraft/deckcraft-patch.ts",
    "9db379ed0971e5c7ced82b9fc0dab4e3c121a3eea28fc4322df3a09dafd677ee",
  ],
  [
    "scripts/artcraft/deckcraft-build.ts",
    "29b150ae5c89fb12ab89b869defc523e8181232e521e93407449c0f3a6d27567",
  ],
]) {
  const body = await readFile(path!);

  if (sha256(body) !== hash) throw new Error(`Final Opus frozen source changed: ${path}`);
  const retainedPath = `frozen-source-${frozenSources.length}.txt`;
  await writeFile(join(output, retainedPath), body, { flag: "wx" });
  frozenSources.push({ path: path!, bytes: body.length, sha256: hash! });
}

let containerExitStatus: number | null = null;

try {
  const result = z
    .object({ status: z.number().int() })
    .parse(
      JSON.parse(
        (await readAcquisitionFile(join(stage, "output"), "container-result.json")).toString(),
      ),
    );

  if (result.status !== 0) throw new Error("Recorded final container exit was not successful");
  containerExitStatus = result.status;
} catch (cause) {
  if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
}

const completedDriverCommands = [];

for (const id of ["rustc", "cargo-build", "metadata", "normal-tree", "host-tree", "trunk"]) {
  const result = z
    .object({ status: z.literal(0), elapsedMs: z.number().nonnegative() })
    .parse(
      JSON.parse(
        (await readAcquisitionFile(join(stage, "output"), `${id}.result.json`)).toString(),
      ),
    );

  completedDriverCommands.push({ id, ...result });
}

const sourceSummary = {
  schemaVersion: 1,
  artifactVersion: "0.14.1-hyori-host.2",
  sourceArchiveSha256,
  originalCommit: "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
  sourceCargoLockSha256: plan.sourceCargoLockSha256,
  exactSourceReplayVerified: true,
  completedDriverCommands,
  containerExitStatus,
  containerAttachmentCompletionObserved: containerExitStatus !== null,
  collectionNote:
    containerExitStatus === null
      ? "Original session/attachment ended without a container-result record. All six actual driver commands, including Cargo and Trunk, recorded exit 0 and complete outputs; container exit status is not fabricated."
      : "Exact container completion record retained.",
  sourceMembers: replayed.files.size,
  changedFiles: changes,
  frozenAuthorSources: frozenSources,
  reusedHyoriInputs: {
    faviconSha256: favicon.sha256,
    iconSha256: sha256(replayed.files.get("assets/hyori-mark.png")!),
  },
  protocolJavaScriptChangedFromV1: true,
  protocolJavaScriptSha256: hostJs.sha256,
  finalFunctionalCorrections: [
    "PPTX Ctrl+S defaults to an explicit native .deckcraft copy, never overwrites the import",
    "Read-only replacement stays rejected; explicit authorized Save As remains possible",
  ],
  protocol: 1,
  rustHostVersion: "0.14.1-hyori-host.2",
  legalBytesUnchanged: true,
  marks: {
    owner: "Opus exact source patch",
    productPresentation: "Hyori Presentations",
    sourceReplacementVerified: true,
    builtInThemeIdentifier:
      "DeckCraft retained as a compatibility/theme identifier, not the modified product name",
    unusedOriginalBrandSourceAssets:
      "Not included as runtime payloads; original source provenance is preserved, no blanket byte-search absence claim",
    renderedBrowserApproval: false,
  },
  content: {
    sfntInstances: afterFonts.length,
    exactFontHashesUnchanged: true,
    sharedEframeSnippetUnchanged: true,
    fullNoticeAuditComplete: false,
    compilerGeneratedNoticeAuditComplete: false,
    legalOpinion: false,
  },
  actualSdkBackendIntegration: false,
  realBrowserWasmRoundTrip: false,
  pptxFidelityVerified: false,
};

await writeFile(
  join(output, "source-summary.json"),
  `${JSON.stringify(sourceSummary, null, 2)}\n`,
  { flag: "wx" },
);

for (const name of [
  "container-command.json",
  ...(containerExitStatus === null ? [] : ["container-result.json"]),
])
  await writeFile(join(output, name), await readAcquisitionFile(join(stage, "output"), name), {
    flag: "wx",
  });

const receipt = {
  schemaVersion: 1,
  kind: "marked-modified-deck-static-receipt",
  artifactVersion: "0.14.1-hyori-host.2",
  sourceArchiveSha256,
  buildManifestSha256: sha256(buildBytes),
  payloadSha256: sha256(Buffer.from(JSON.stringify(files))),
  files,
  sourceSummarySha256: sha256(Buffer.from(`${JSON.stringify(sourceSummary, null, 2)}\n`)),
  proof: {
    isolatedOfflineLockedWasmBuild: true,
    exactSourceReplayVerified: true,
    sourceMarksReplacementVerified: true,
    originalFontNoticeInputsUnchanged: true,
    legalOpinion: false,
    actualSdkBackendIntegration: false,
    realBrowserWasmRoundTrip: false,
    allFourLaunchReady: false,
  },
};

const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);

await writeFile(join(output, "receipt.json"), receiptBytes, { flag: "wx" });

console.log(
  JSON.stringify(
    {
      receipt: join(output, "receipt.json"),
      receiptSha256: sha256(receiptBytes),
      buildManifestSha256: receipt.buildManifestSha256,
      sourceArchiveSha256,
      payloadSha256: receipt.payloadSha256,
    },
    null,
    2,
  ),
);

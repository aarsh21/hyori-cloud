import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { cargoMetadataSchema, hostInclusiveIds, parseTargetTree } from "./closure-graph.ts";
import { checkClosureEvidence } from "./closure.ts";
import { sha256 } from "./evidence-bytes.ts";
import { nativeApps, readPinnedSource } from "./native-v3-source.ts";
import { nativeProductNames } from "./native-v3-marks.ts";

const commandIds = ["rustc", "cargo-build", "metadata", "normal-tree", "host-tree", "trunk"];

/** Legal members that every modified build must carry byte-identically from the tagged source. */
export const originalLegalPaths = [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "NOTICE",
  "ATTRIBUTION.md",
  "docs/brand/LICENSE-brand.txt",
];

const planSchema = z.object({
  kind: z.literal("hyori-native-host-v3-build-inputs"),
  app: z.enum(nativeApps),
  artifactVersion: z.string(),
  upstreamVersion: z.string(),
  sourcePin: z.object({ url: z.string(), sha256: z.string(), commit: z.string() }),
  sourceCargoLockSha256: z.string(),
  stages: z.array(z.string()),
  paletteCssSha256: z.string(),
  hostJavaScriptSha256: z.string(),
  patchedFiles: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string() }),
  ),
  files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  deployable: z.literal(false),
});

const resultSchema = z.object({ status: z.number(), elapsedMs: z.number() });

type FileRecord = { path: string; bytes: number; sha256: string };

/** Canonical payload identity shared with the server: ASCII-sorted compact {path,bytes,sha256}. */
export function payloadSha256(files: readonly FileRecord[]) {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));

  return sha256(Buffer.from(JSON.stringify(sorted)));
}

/** Collects a completed native v3 build into a new evidence root; never trusts claimed success. */
export async function collectNativeEvidence(
  stageRoot: string,
  output: string,
  tools: string,
  archivePath: string,
) {
  const planBytes = await readFile(join(stageRoot, "build-inputs.json"));
  const plan = planSchema.parse(JSON.parse(planBytes.toString()));
  const { app } = plan;
  const prefix = `${app}/${plan.artifactVersion}`;
  const { original } = readPinnedSource(app, await readFile(archivePath));

  if (sha256(original.get("Cargo.lock")!) !== plan.sourceCargoLockSha256)
    throw new Error("Build plan names a different tagged source");

  await mkdir(output);
  const assets: FileRecord[] = [];

  async function retain(path: string, bytes: Buffer) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes, { flag: "wx" });
    assets.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const commands: { id: string; status: number; elapsedMs: number }[] = [];

  for (const id of commandIds) {
    const result = resultSchema.parse(
      JSON.parse(await readFile(join(stageRoot, `output/${id}.result.json`), "utf8")),
    );

    if (result.status !== 0) throw new Error(`Cannot claim an artifact after ${id} failed`);
    commands.push({ id, ...result });

    for (const suffix of ["command.json", "result.json", "stdout", "stderr"])
      await retain(`commands/${id}.${suffix}`, await readFile(join(stageRoot, `output/${id}.${suffix}`)));
  }

  for (const input of plan.files) {
    const bytes = await readFile(join(stageRoot, "input", input.path));

    if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
      throw new Error(`Build input changed: ${input.path}`);
  }

  const lock = await readFile(join(stageRoot, "output/Cargo.lock"));

  if (sha256(lock) !== plan.sourceCargoLockSha256) throw new Error("Built lock changed from tagged source");

  // The dependency graph must equal the one whose notices the shared legal tree already carries.
  const root = `/hyori-native-v3/${app}/work/source`;
  const normalize = (text: string) => text.replaceAll(root, `<${app}-source>`);

  const metadata = cargoMetadataSchema.parse(
    JSON.parse(await readFile(join(stageRoot, "output/metadata.stdout"), "utf8")),
  );

  const normal = parseTargetTree(await readFile(join(stageRoot, "output/normal-tree.stdout"), "utf8"), metadata);
  const hostIds = hostInclusiveIds(await readFile(join(stageRoot, "output/host-tree.stdout"), "utf8"), metadata);
  const closure = await checkClosureEvidence();
  const recorded = closure.manifest.apps.find((entry) => entry.app === app);

  if (!recorded || normalize(JSON.stringify(normal)) !== JSON.stringify(recorded.normal))
    throw new Error("Modified build graph differs from the noticed upstream graph; review required");

  if (
    JSON.stringify(hostIds.map(normalize).sort()) !==
    JSON.stringify([...recorded.hostInclusiveIds].sort())
  )
    throw new Error("Modified host graph differs from the noticed upstream graph");

  await retain("Cargo.lock", lock);
  await retain("build-inputs.json", planBytes);
  await retain("tool-inputs.json", await readFile(join(stageRoot, "tool-inputs.json")));
  await retain("driver.js", await readFile(join(stageRoot, "driver/driver.js")));

  for (const changed of plan.patchedFiles) {
    const bytes = await readFile(join(stageRoot, "input/source", changed.path));

    if (sha256(bytes) !== changed.after) throw new Error(`Modified source changed: ${changed.path}`);
    await retain(`modified-source/${changed.path}`, bytes);
  }

  for (const path of originalLegalPaths) {
    const bytes = await readFile(join(stageRoot, "input/source", path));

    if (!original.get(path)?.equals(bytes)) throw new Error(`Original legal bytes changed: ${path}`);
    await retain(`original-legal/${path}`, bytes);
  }

  async function copyTree(base: string, target: string, relative = ""): Promise<void> {
    for (const name of (await readdir(join(base, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(base, path));

      if (info.isSymbolicLink()) throw new Error(`Unexpected link: ${path}`);

      if (info.isDirectory()) await copyTree(base, target, path);
      else if (info.isFile()) await retain(`${target}/${path}`, await readFile(join(base, path)));
      else throw new Error(`Unexpected special file: ${path}`);
    }
  }

  await copyTree(join(stageRoot, "input/legal/host-bridge"), "host-bridge-legal");
  await copyTree(join(tools, "legal"), "tool-legal");
  await copyTree(join(stageRoot, "output/dist"), "artifact");

  const artifact = assets.filter((asset) => asset.path.startsWith("artifact/"));
  const wasm = artifact.filter((asset) => asset.path.endsWith("_bg.wasm"));

  if (wasm.length !== 1) throw new Error("Expected exactly one editor WASM output");

  const html = await readFile(join(output, "artifact/index.html"), "utf8");

  const files = artifact
    .map((asset) => ({ ...asset, path: `${prefix}/${asset.path.slice("artifact/".length)}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (!html.includes(`<title>${nativeProductNames[app]}</title>`) || html.includes("app-icon"))
    throw new Error("Built entry still presents upstream marks");

  const sourceSummary = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-source-summary",
    app,
    artifactVersion: plan.artifactVersion,
    upstreamVersion: plan.upstreamVersion,
    productPresentation: nativeProductNames[app],
    sourcePin: plan.sourcePin,
    sourceCargoLockSha256: plan.sourceCargoLockSha256,
    cargoLockUnchanged: true,
    cargoManifestsUnchanged: true,
    stages: plan.stages,
    paletteCssSha256: plan.paletteCssSha256,
    hostJavaScriptSha256: plan.hostJavaScriptSha256,
    changedFiles: plan.patchedFiles,
    originalLegalBytesUnchanged: originalLegalPaths.map((path) => ({
      path,
      sha256: sha256(original.get(path)!),
    })),
    dependencyGraphEqualsNoticedUpstreamGraph: {
      targetNormalPackages: normal.packages.length,
      hostInclusivePackages: hostIds.length,
    },
  };

  const sourceSummaryBytes = Buffer.from(`${JSON.stringify(sourceSummary, null, 2)}\n`);
  await retain("source-summary.json", sourceSummaryBytes);

  const buildManifest = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-build",
    app,
    artifactVersion: plan.artifactVersion,
    officialReleaseReplaced: false,
    buildInputsSha256: sha256(planBytes),
    cargoLockSha256: sha256(lock),
    tools: pins,
    execution:
      "Native stand-in for the restricted container: empty environment, pinned Bun/Rust/Trunk/wasm-bindgen/Binaryen at the pinned absolute paths, read-only root-owned inputs, Cargo and Trunk --locked --offline. No network namespace isolation (the host kernel denies namespaces).",
    commands,
    wasm: wasm[0]!,
    assets: assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };

  const buildManifestBytes = Buffer.from(`${JSON.stringify(buildManifest, null, 2)}\n`);
  await writeFile(join(output, "build-manifest.json"), buildManifestBytes, { flag: "wx" });

  const receipt = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-receipt",
    app,
    artifactVersion: plan.artifactVersion,
    bridge: "hyori-correlated-host-v2",
    protocol: 2,
    sourceArchiveSha256: plan.sourcePin.sha256,
    buildManifestSha256: sha256(buildManifestBytes),
    sourceSummarySha256: sha256(sourceSummaryBytes),
    wasmSha256: wasm[0]!.sha256,
    payloadSha256: payloadSha256(files),
    files,
  };

  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });

  return { app, version: plan.artifactVersion, wasm: wasm[0], payloadSha256: receipt.payloadSha256 };
}

if (import.meta.main) {
  const [, , stage, output, tools, archive] = process.argv;

  if (!stage || !output || !tools || !archive || process.argv.length !== 6)
    throw new Error(
      "Usage: bun scripts/artcraft/native-v3-build-evidence.ts COMPLETED_STAGING NEW_EVIDENCE PINNED_TOOLS VERIFIED_SOURCE_TAR_GZ",
    );

  console.log(
    JSON.stringify(
      await collectNativeEvidence(resolve(stage), resolve(output), resolve(tools), resolve(archive)),
      null,
      2,
    ),
  );
}

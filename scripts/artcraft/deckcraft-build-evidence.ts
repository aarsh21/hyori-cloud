import { mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { checkClosureEvidence, deploymentClosureManifest, closureNotice } from "./closure.ts";
import { cargoMetadataSchema, parseTargetTree, hostInclusiveIds } from "./closure-graph.ts";
import {
  checkRedistributionEvidence,
  supplementalLegalFiles,
  supplement,
  symphoniaSourceNotice,
} from "./redistribution.ts";
import { sha256 } from "./evidence-bytes.ts";
import { assertAuditedAsset, contentDeliveryFiles } from "./content-delivery.ts";

const planSchema = z.object({
  artifactVersion: z.enum(["0.14.1-hyori-host.1", "0.14.1-hyori-host.2"]),
  deployable: z.literal(false),
  sourceCargoLockSha256: z.string(),
  files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  patchedFiles: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string() }),
  ),
  crates: z.number(),
});

const resultSchema = z.object({ status: z.number(), elapsedMs: z.number() });
const [, , stageArgument, evidenceArgument, toolsArgument] = process.argv;

if (!stageArgument || !evidenceArgument || !toolsArgument || process.argv.length !== 5)
  throw new Error(
    "Usage: bun scripts/artcraft/deckcraft-build-evidence.ts COMPLETED_STAGING NEW_EVIDENCE PINNED_TOOLS",
  );

const stage = resolve(stageArgument);
const output = resolve(evidenceArgument);
const tools = resolve(toolsArgument);
const planBytes = await readFile(join(stage, "build-inputs.json"));
const plan = planSchema.parse(JSON.parse(planBytes.toString()));

const delivery = await contentDeliveryFiles();

await mkdir(output);

const assets: { path: string; bytes: number; sha256: string }[] = [];

async function retain(path: string, bytes: Buffer) {
  await mkdir(dirname(join(output, path)), { recursive: true });
  await writeFile(join(output, path), bytes, { flag: "wx" });
  assets.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

const commands: { id: string; status: number; elapsedMs: number }[] = [];

for (const id of ["rustc", "cargo-build", "metadata", "normal-tree", "host-tree", "trunk"]) {
  const result = resultSchema.parse(
    JSON.parse(await readFile(join(stage, `output/${id}.result.json`), "utf8")),
  );

  commands.push({ id, ...result });

  if (result.status !== 0) throw new Error(`Cannot claim successful artifact after ${id} failure`);

  for (const suffix of ["command.json", "result.json", "stdout", "stderr"])
    await retain(`commands/${id}.${suffix}`, await readFile(join(stage, `output/${id}.${suffix}`)));
}

for (const input of plan.files) {
  const bytes = await readFile(join(stage, "input", input.path));

  if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
    throw new Error(`Build input changed: ${input.path}`);
}

const lock = await readFile(join(stage, "output/Cargo.lock"));

if (sha256(lock) !== plan.sourceCargoLockSha256)
  throw new Error("Built lock changed from tagged source");

await retain("Cargo.lock", lock);

await retain("build-inputs.json", planBytes);

await retain("tool-inputs.json", await readFile(join(stage, "tool-inputs.json")));

await retain(
  "container-command.json",
  await readFile(join(stage, "output/container-command.json")),
);

await retain("driver.js", await readFile(join(stage, "driver/driver.js")));

for (const changed of plan.patchedFiles)
  await retain(
    `modified-source/${changed.path}`,
    await readFile(join(stage, "input/source", changed.path)),
  );

const metadata = cargoMetadataSchema.parse(
  JSON.parse(await readFile(join(stage, "output/metadata.stdout"), "utf8")),
);

const normal = parseTargetTree(
  await readFile(join(stage, "output/normal-tree.stdout"), "utf8"),
  metadata,
);

const hostIds = hostInclusiveIds(
  await readFile(join(stage, "output/host-tree.stdout"), "utf8"),
  metadata,
);

const closure = await checkClosureEvidence();
const recorded = closure.manifest.apps.find((app) => app.app === "deckcraft")!;
const normalizedNormal = JSON.stringify(normal).replaceAll("/work/source", "<deckcraft-source>");

if (normalizedNormal !== JSON.stringify(recorded.normal))
  throw new Error("Modified build graph differs from harvested notice graph; review required");

const normalizedHostIds = hostIds
  .map((id) => id.replaceAll("/work/source", "<deckcraft-source>"))
  .sort();

if (JSON.stringify(normalizedHostIds) !== JSON.stringify([...recorded.hostInclusiveIds].sort()))
  throw new Error("Modified host graph differs from harvested notice graph");

await retain(
  "resolved-graph.json",
  Buffer.from(
    JSON.stringify(
      {
        normal,
        hostInclusiveIds: hostIds,
        hostOnlyIds: hostIds.filter((id) => !normal.packages.some((pkg) => pkg.id === id)),
      },
      null,
      2,
    ),
  ),
);

async function copyTree(base: string, prefix: string, relative = "") {
  for (const name of await readdir(join(base, relative))) {
    const path = join(relative, name);
    const info = await lstat(join(base, path));

    if (info.isSymbolicLink()) throw new Error(`Unexpected output link: ${path}`);

    if (info.isDirectory()) await copyTree(base, prefix, path);
    else if (info.isFile()) {
      const body = await readFile(join(base, path));

      if (prefix === "artifact" && plan.artifactVersion === "0.14.1-hyori-host.1")
        assertAuditedAsset(delivery.discovered, "deckcraft@0.14.1-hyori-host.1", path, body);
      await retain(`${prefix}/${path}`, body);
    } else throw new Error(`Unexpected special output: ${path}`);
  }
}

await copyTree(join(stage, "output/dist"), "artifact");

const wasm = assets.filter(
  (asset) => asset.path.startsWith("artifact/") && asset.path.endsWith(".wasm"),
);

if (wasm.length !== 1) throw new Error("Expected exactly one modified editor WASM output");

const verified = await checkRedistributionEvidence();
const release = official.editors.find((release) => release.app === "deckcraft");

if (!release) throw new Error("Missing preserved official DeckCraft descriptor");

for (const legal of [
  ...release.legal,
  ...supplementalLegalFiles().filter(
    (file) =>
      file.path.startsWith("licenses/shared/") || file.path.startsWith("licenses/deckcraft/"),
  ),
  supplement,
])
  await retain(`artifact/legal/${legal.path.slice("licenses/".length)}`, verified.get(legal.path)!);

await retain("artifact/legal/SYMPHONIA-SOURCES.md", Buffer.from(symphoniaSourceNotice()));

const packages = closure.manifest.packages.filter((pkg) => pkg.apps.includes("deckcraft"));
const legalPaths = new Set(packages.flatMap((pkg) => pkg.files));

const subset = {
  ...closure.manifest,
  apps: closure.manifest.apps.filter((app) => app.app === "deckcraft"),
  packages,
  files: closure.manifest.files.filter((file) => legalPaths.has(file.path)),
};

for (const file of subset.files.filter((file) => file.role === "legal"))
  await retain(
    `artifact/legal/closure/${file.path.slice("legal/".length)}`,
    closure.files.get(file.path)!,
  );

await retain(
  "artifact/legal/closure.json",
  Buffer.from(JSON.stringify(deploymentClosureManifest(subset), null, 2)),
);

await retain("artifact/legal/DEPENDENCY-NOTICES.md", Buffer.from(closureNotice(subset)));

for (const path of [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "NOTICE",
  "ATTRIBUTION.md",
  "docs/brand/LICENSE-brand.txt",
])
  await retain(
    `artifact/legal/modified-deckcraft/${path}`,
    await readFile(join(stage, "input/source", path)),
  );

await copyTree(join(stage, "input/legal"), "artifact/legal/host-bridge");

await copyTree(join(tools, "legal"), "tool-legal-inputs");

for (const [path, body] of delivery.files) await retain(`artifact/${path}`, body);

const artifactManifest = {
  schemaVersion: 1,
  kind: "experimental-modified-source-build",
  artifactVersion: plan.artifactVersion,
  officialReleaseReplaced: false,
  deployable: false,
  builtInputsSha256: sha256(planBytes),
  cargoLockSha256: sha256(lock),
  tools: pins,
  commands,
  graph: {
    targetNormalPackages: normal.packages.length,
    hostInclusivePackages: hostIds.length,
    targetFeaturesEqualRetainedDeckCraftGraph: true,
    linkedFunctionInventoryVerified: false,
  },
  noticeInputs: {
    selectedDeckCraftPackages: packages.length,
    localNoticeIndex: "legal/NOTICE-INDEX.md",
    contentNoticeManifest: "legal/content/notice-manifest.json",
    contentSupplementIndexSha256: delivery.indexSha256,
    localNoticeDeliveryVerified: true,
    runtimePublication: false,
    fullContentAuditComplete: false,
    compilerGeneratedNoticesComplete: false,
  },
  proof: {
    isolatedOfflineLockedWasmBuild: true,
    bitIdenticalIndependentRebuild: false,
    actualSdkBackendIntegration: false,
    realBrowserWasmRoundTrip: false,
    pptxFidelityVerified: false,
    protectedMarksReplaced: false,
  },
  containerAttachment:
    "Command result files establish tool outcomes; container exit and any attachment interruptions are recorded in the separate execution receipt.",
  assets: assets.sort((a, b) => a.path.localeCompare(b.path, "en")),
};

await writeFile(join(output, "manifest.json"), `${JSON.stringify(artifactManifest, null, 2)}\n`, {
  flag: "wx",
});

console.log(
  JSON.stringify(
    {
      manifest: join(output, "manifest.json"),
      wasm,
      targetNormalPackages: normal.packages.length,
      hostInclusivePackages: hostIds.length,
      deployable: false,
    },
    null,
    2,
  ),
);

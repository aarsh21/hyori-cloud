import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { noticeMembers } from "./closure-collect.ts";
import { cargoMetadataSchema, hostInclusiveIds, parseTargetTree } from "./closure-graph.ts";
import { checkClosureEvidence } from "./closure.ts";
import { digest } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";
import {
  candidateArtifactVersions,
  composeCandidateSource,
  readCandidateSource,
} from "./native-v3-candidate.ts";
import {
  nativeApps,
  nativeAuthoredInputs,
  nativeSourceCommits,
  readPinnedSource,
} from "./native-v3-source.ts";
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
  buildCargoLockSha256: digest.optional(),
  stages: z.array(z.string()),
  paletteCssSha256: z.string(),
  hostJavaScriptSha256: z.string(),
  embeddedFonts: z
    .object({
      source: z.object({ repository: z.string(), commit: z.string() }).loose(),
      license: z.string(),
      faces: z.array(
        z.object({ family: z.string(), style: z.string(), sha256: z.string() }).loose(),
      ),
    })
    .loose()
    .nullable()
    .optional(),
  patchedFiles: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string() }),
  ),
  files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  deployable: z.literal(false),
});

const resultSchema = z.object({ status: z.number(), elapsedMs: z.number() });

const candidateNoticeRoot = new URL("../../tooling/artcraft/notices-r6/", import.meta.url);

const candidateGraphsSchema = z.array(
  z.object({
    app: z.enum(nativeApps),
    normalSha256: digest,
    hostInclusiveSha256: digest,
    inherited: z.array(z.string()),
    supplemental: z.array(z.string()),
  }),
);

const candidateNoticesSchema = z.object({
  packages: z.array(
    z.object({
      id: z.string(),
      members: z.array(z.object({ sha256: digest, bytes: z.number().int().positive() })).min(1),
    }),
  ),
});

const candidateAuditSchema = z.object({
  audits: z.array(
    z.object({
      app: z.enum(nativeApps),
      artifactVersion: z.string(),
      cargoLockSha256: digest,
      normalSha256: digest,
      hostInclusiveSha256: digest,
      findings: z.array(z.object({ waiver: z.string().min(1) })),
    }),
  ),
});

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
  const candidate = plan.artifactVersion === candidateArtifactVersions[app];

  const { pin, original } = (candidate ? readCandidateSource : readPinnedSource)(
    app,
    await readFile(archivePath),
  );

  if (
    pin.sourceSha256 !== plan.sourcePin.sha256 ||
    pin.sourceUrl !== plan.sourcePin.url ||
    ("commit" in pin ? pin.commit : nativeSourceCommits[app]) !== plan.sourcePin.commit ||
    pin.version !== plan.upstreamVersion ||
    sha256(original.get("Cargo.lock")!) !== plan.sourceCargoLockSha256
  )
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
      await retain(
        `commands/${id}.${suffix}`,
        await readFile(join(stageRoot, `output/${id}.${suffix}`)),
      );
  }

  for (const input of plan.files) {
    const bytes = await readFile(join(stageRoot, "input", input.path));

    if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
      throw new Error(`Build input changed: ${input.path}`);
  }

  const lock = await readFile(join(stageRoot, "output/Cargo.lock"));
  const buildLockSha256 = sha256(lock);
  const hostedPdf = candidate && app === "pdfcraft";

  if (buildLockSha256 !== (plan.buildCargoLockSha256 ?? plan.sourceCargoLockSha256))
    throw new Error("Built lock changed from the prepared build input");

  // The tagged archive is authoritative except for the committed hosted PDF patch. Replay that
  // patch so a staged plan alone cannot authorize a different lock or a stale host handshake.
  if (hostedPdf) {
    const scratch = await mkdtemp(join(dirname(output), ".check-dependencies-"));

    try {
      const reviewed = await composeCandidateSource(
        app,
        original,
        await nativeAuthoredInputs(),
        scratch,
      );

      for (const path of [
        "Cargo.lock",
        "crates/engine/Cargo.toml",
        "crates/ui-egui/Cargo.toml",
        "apps/pdfcraft-web/src/native_host.rs",
      ]) {
        const input = await readFile(join(stageRoot, "input/source", path));

        if (
          !reviewed.files.get(path)?.equals(input) ||
          (path === "Cargo.lock" && !lock.equals(input))
        )
          throw new Error(`Hosted PDF has an unreviewed build input: ${path}`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else if (buildLockSha256 !== plan.sourceCargoLockSha256) {
    throw new Error("Built lock changed from tagged source");
  }

  // The dependency graph must equal the one whose notices the shared legal tree already carries.
  const root = `/hyori-native-v3/${app}/work/source`;
  const normalize = (text: string) => text.replaceAll(root, `<${app}-source>`);

  const metadata = cargoMetadataSchema.parse(
    JSON.parse(await readFile(join(stageRoot, "output/metadata.stdout"), "utf8")),
  );

  const normal = parseTargetTree(
    await readFile(join(stageRoot, "output/normal-tree.stdout"), "utf8"),
    metadata,
  );

  const hostIds = hostInclusiveIds(
    await readFile(join(stageRoot, "output/host-tree.stdout"), "utf8"),
    metadata,
  );

  if (hostedPdf) {
    const target = new Set(normal.packages.map(({ id }) => id));
    const dependencies = metadata.packages.filter(({ id }) => target.has(id));

    const recognition = dependencies.filter(({ name }) =>
      /(?:^|[-_])(?:ocr|ocrs|rten|onnx)(?:$|[-_])/iu.test(name),
    );

    if (recognition.length)
      throw new Error(
        `Hosted PDF target includes OCR dependencies: ${recognition.map(({ id }) => id).join(", ")}`,
      );

    const urls = dependencies.filter(({ name }) => name === "url");

    if (urls.length !== 1 || urls[0]?.version !== "2.5.9")
      throw new Error("Hosted PDF target does not use the reviewed url 2.5.9 dependency");
  }

  const { manifest: closure } = await checkClosureEvidence();
  const normalJson = normalize(JSON.stringify(normal));
  const hostJson = JSON.stringify(hostIds.map(normalize).sort());

  if (candidate) {
    const graphs = await readFile(new URL("graphs.json", candidateNoticeRoot));
    const notices = await readFile(new URL("notices.json", candidateNoticeRoot));

    const recorded = candidateGraphsSchema
      .parse(JSON.parse(graphs.toString()))
      .find((entry) => entry.app === app);

    if (
      !recorded ||
      sha256(Buffer.from(normalJson)) !== recorded.normalSha256 ||
      sha256(Buffer.from(hostJson)) !== recorded.hostInclusiveSha256
    )
      throw new Error(`Modified ${app} build graph differs from the noticed r6 graph`);

    const included = new Set(hostIds);
    const inherited = new Set(closure.packages.map(({ id }) => id));
    const external = metadata.packages.filter(({ id, source }) => source && included.has(id));

    const noticesById = new Map(
      candidateNoticesSchema
        .parse(JSON.parse(notices.toString()))
        .packages.map((entry) => [entry.id, entry]),
    );

    if (
      JSON.stringify(external.map(({ id }) => id).sort()) !==
        JSON.stringify([...recorded.inherited, ...recorded.supplemental].sort()) ||
      recorded.inherited.some((id) => !inherited.has(id))
    )
      throw new Error(`Incomplete ${app} r6 dependency notice inventory`);

    for (const id of recorded.supplemental) {
      const entry = noticesById.get(id);

      if (!entry) throw new Error(`Missing r6 notice evidence for ${id}`);

      for (const member of entry.members) {
        const path = `texts/${member.sha256}`;
        const bytes = await readFile(new URL(path, candidateNoticeRoot));

        if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256)
          throw new Error(`R6 notice text changed: ${id} ${path}`);

        if (!assets.some((asset) => asset.path === `dependency-notices/${path}`))
          await retain(`dependency-notices/${path}`, bytes);
      }
    }

    const audit = await readFile(new URL("rustsec.json", candidateNoticeRoot));

    const audited = candidateAuditSchema
      .parse(JSON.parse(audit.toString()))
      .audits.find((entry) => entry.app === app);

    if (
      audited?.cargoLockSha256 !== buildLockSha256 ||
      audited.artifactVersion !== plan.artifactVersion ||
      audited.normalSha256 !== recorded.normalSha256 ||
      audited.hostInclusiveSha256 !== recorded.hostInclusiveSha256
    )
      throw new Error(`RustSec audit waivers do not match the ${app} artifact, lock and graphs`);

    await retain("dependency-notices/graphs.json", graphs);
    await retain("dependency-notices/notices.json", notices);
    await retain("dependency-notices/rustsec.json", audit);
  } else {
    const recorded = closure.apps.find((entry) => entry.app === app);

    if (!recorded || normalJson !== JSON.stringify(recorded.normal))
      throw new Error(
        "Modified build graph differs from the noticed upstream graph; review required",
      );

    if (hostJson !== JSON.stringify([...recorded.hostInclusiveIds].sort()))
      throw new Error("Modified host graph differs from the noticed upstream graph");
  }

  // native-v3-container.ts leaves its exact command and exit beside the stage; r1 ran natively.
  let container: { command: Buffer; result: Buffer } | null = null;

  try {
    container = {
      command: await readFile(join(stageRoot, "container-command.json")),
      result: await readFile(join(stageRoot, "container-result.json")),
    };
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  if (container) {
    if (resultSchema.parse(JSON.parse(container.result.toString())).status !== 0)
      throw new Error("Cannot claim an artifact after the build container failed");
    await retain("container-command.json", container.command);
    await retain("container-result.json", container.result);
  }

  await retain("Cargo.lock", lock);
  await retain("build-inputs.json", planBytes);
  await retain("tool-inputs.json", await readFile(join(stageRoot, "tool-inputs.json")));
  await retain("driver.js", await readFile(join(stageRoot, "driver/driver.js")));

  for (const changed of plan.patchedFiles) {
    const bytes = await readFile(join(stageRoot, "input/source", changed.path));

    if (sha256(bytes) !== changed.after)
      throw new Error(`Modified source changed: ${changed.path}`);
    await retain(`modified-source/${changed.path}`, bytes);
  }

  const legalPaths = candidate
    ? [...new Set([...originalLegalPaths, ...noticeMembers(original, "", null).paths])]
    : originalLegalPaths;

  for (const path of legalPaths) {
    const bytes = await readFile(join(stageRoot, "input/source", path));

    if (!original.get(path)?.equals(bytes))
      throw new Error(`Original legal bytes changed: ${path}`);
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

  if (plan.embeddedFonts) await copyTree(join(stageRoot, "input/legal/fonts"), "font-legal");
  await copyTree(join(tools, "legal"), "tool-legal");
  await copyTree(join(stageRoot, "output/dist"), "artifact");

  const artifact = assets.filter((asset) => asset.path.startsWith("artifact/"));
  const wasm = artifact.filter((asset) => asset.path.endsWith("_bg.wasm"));

  if (wasm.length !== 1) throw new Error("Expected exactly one editor WASM output");

  if (hostedPdf && artifact.some(({ path }) => /ocr|\.onnx$/iu.test(path)))
    throw new Error("Hosted PDF must not ship OCR workers or model assets");

  const html = await readFile(join(output, "artifact/index.html"), "utf8");

  const files = artifact
    .map((asset) => ({ ...asset, path: `${prefix}/${asset.path.slice("artifact/".length)}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (!html.includes(`<title>${nativeProductNames[app]}</title>`) || html.includes("app-icon"))
    throw new Error("Built entry still presents upstream marks");

  // Trunk starts the engine from an inline module script. Its CSP hash lets the gateway send
  // `script-src 'self' 'wasm-unsafe-eval' <hash>` without 'unsafe-inline'.
  const inlineScripts = [
    ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu),
  ].map((match) => `sha256-${createHash("sha256").update(match[1]!, "utf8").digest("base64")}`);

  if (inlineScripts.length !== 1) throw new Error("Expected exactly one inline loader script");

  const sourceSummary = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-source-summary",
    app,
    artifactVersion: plan.artifactVersion,
    upstreamVersion: plan.upstreamVersion,
    productPresentation: nativeProductNames[app],
    sourcePin: plan.sourcePin,
    sourceCargoLockSha256: plan.sourceCargoLockSha256,
    buildCargoLockSha256: hostedPdf ? buildLockSha256 : undefined,
    cargoLockUnchanged: buildLockSha256 === plan.sourceCargoLockSha256,
    cargoManifestsUnchanged: !plan.patchedFiles.some(({ path }) => path.endsWith("Cargo.toml")),
    stages: plan.stages,
    paletteCssSha256: plan.paletteCssSha256,
    hostJavaScriptSha256: plan.hostJavaScriptSha256,
    // Absent for apps that embed no fonts: JSON omits undefined.
    embeddedFonts: plan.embeddedFonts ?? undefined,
    changedFiles: plan.patchedFiles,
    originalLegalBytesUnchanged: legalPaths.map((path) => ({
      path,
      sha256: sha256(original.get(path)!),
    })),
    dependencyGraphEqualsNoticedUpstreamGraph: hostedPdf
      ? undefined
      : { targetNormalPackages: normal.packages.length, hostInclusivePackages: hostIds.length },
    hostedPdfDependencyGraph: hostedPdf
      ? {
          target: "wasm32-unknown-unknown",
          targetNormalPackages: normal.packages.length,
          hostInclusivePackages: hostIds.length,
          recognitionDependencies: "none",
          urlVersion: "2.5.9",
        }
      : undefined,
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
    cargoLockSha256: buildLockSha256,
    tools: pins,
    execution: container
      ? "Restricted container (container-command.json): pinned Rust base image, no network, unprivileged, read-only root, all capabilities dropped, no-new-privileges, bounded memory/CPU/processes; read-only input/driver/tools mounts at the driver's absolute paths. Cargo and Trunk --locked --offline."
      : "Native stand-in for the restricted container: empty environment, pinned Bun/Rust/Trunk/wasm-bindgen/Binaryen at the pinned absolute paths, read-only root-owned inputs, Cargo and Trunk --locked --offline. No network namespace isolation (the host kernel denies namespaces).",
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
    // The sandboxed-frame bridge; native-v3-runtime refuses a receipt for another revision.
    bridge: "hyori-correlated-host-v3",
    protocol: 3,
    sourceArchiveSha256: plan.sourcePin.sha256,
    buildManifestSha256: sha256(buildManifestBytes),
    sourceSummarySha256: sha256(sourceSummaryBytes),
    wasmSha256: wasm[0]!.sha256,
    payloadSha256: payloadSha256(files),
    cspScriptHashes: inlineScripts,
    files,
  };

  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });

  return {
    app,
    version: plan.artifactVersion,
    wasm: wasm[0],
    payloadSha256: receipt.payloadSha256,
  };
}

if (import.meta.main) {
  const [, , stage, output, tools, archive] = process.argv;

  if (!stage || !output || !tools || !archive || process.argv.length !== 6)
    throw new Error(
      "Usage: bun scripts/artcraft/native-v3-build-evidence.ts COMPLETED_STAGING NEW_EVIDENCE PINNED_TOOLS VERIFIED_SOURCE_TAR_GZ",
    );

  console.log(
    JSON.stringify(
      await collectNativeEvidence(
        resolve(stage),
        resolve(output),
        resolve(tools),
        resolve(archive),
      ),
      null,
      2,
    ),
  );
}

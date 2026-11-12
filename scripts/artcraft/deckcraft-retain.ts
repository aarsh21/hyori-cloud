import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const [, , stageArgument, buildArgument, browserArgument, sourceArgument, destinationArgument] =
  process.argv;

if (
  !stageArgument ||
  !buildArgument ||
  !browserArgument ||
  !sourceArgument ||
  !destinationArgument ||
  process.argv.length !== 7
)
  throw new Error(
    "Usage: bun scripts/artcraft/deckcraft-retain.ts STAGING BUILD_EVIDENCE PASSED_BROWSER_EVIDENCE VERIFIED_SOURCE_ARCHIVE NEW_RETAINED_RUN",
  );

const stage = resolve(stageArgument);
const build = resolve(buildArgument);
const browser = resolve(browserArgument);
const output = resolve(destinationArgument);
const executionBytes = await readFile(join(stage, "execution.json"));

const execution = z
  .object({
    initialAttachmentTimedOut: z.boolean(),
    containerExitStatus: z.literal(0),
    initialFailures: z.array(z.string()),
  })
  .parse(JSON.parse(executionBytes.toString()));

const manifestBytes = await readFile(join(build, "manifest.json"));

const manifest = z
  .object({
    artifactVersion: z.literal("0.14.1-hyori-host.1"),
    deployable: z.literal(false),
    assets: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })),
  })
  .parse(JSON.parse(manifestBytes.toString()));

const browserBytes = await readFile(join(browser, "result.json"));

const result = z
  .object({
    status: z.literal("passed"),
    realWasmExecuted: z.literal(true),
    nativeReopenedInWasm: z.literal(true),
    cloudPersistenceVerified: z.literal(false),
    pptxFidelityVerified: z.literal(false),
  })
  .parse(JSON.parse(browserBytes.toString()));

for (const file of manifest.assets)
  if (sha256(await readFile(join(build, file.path))) !== file.sha256)
    throw new Error(`Modified bundle changed: ${file.path}`);

const archive = await readFile(sourceArgument);

if (sha256(archive) !== "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7")
  throw new Error("Source archive changed");

const original = readGitSourceArchive(
  archive,
  "deckcraft-0.14.1",
  "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
);

const hostJavaScript = await readFile(join(stage, "input/source/apps/deckcraft-web/hyori-host.js"));

const replayed = patchDeckCraft(original, {
  hostRust: await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
  hostJavaScript,
});

for (const [path, bytes] of replayed.files)
  if (!bytes.equals(await readFile(join(stage, "input/source", path))))
    throw new Error(`Current Rust patch cannot replay compiled source: ${path}`);

await mkdir(output);

const retained: { path: string; bytes: number; sha256: string }[] = [];

async function retain(path: string, bytes: Buffer) {
  await mkdir(dirname(join(output, path)), { recursive: true });
  await writeFile(join(output, path), bytes, { flag: "wx" });
  retained.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

await retain("build-manifest.json", manifestBytes);

await retain("execution.json", executionBytes);

for (const path of [
  "build-inputs.json",
  "tool-inputs.json",
  "container-command.json",
  "resolved-graph.json",
])
  await retain(path, await readFile(join(build, path)));

// Generated browser module is retained as non-executable data, never a handwritten JS tool.
await retain("host-bridge.js.source", hostJavaScript);

for (const name of await readdir(join(build, "commands")))
  if (!name.endsWith(".stdout") || name.startsWith("trunk.") || name.startsWith("rustc."))
    await retain(`commands/${name}`, await readFile(join(build, "commands", name)));

for (const name of ["result.json", "events.json", "browser-version.json", "browser-command.json"])
  await retain(`browser/${name}`, await readFile(join(browser, name)));

for (const name of ["LICENSE", "package.json"])
  await retain(`legal/zod/${name}`, await readFile(join(stage, "input/legal/zod", name)));

await writeFile(
  join(output, "result.json"),
  `${JSON.stringify({ schemaVersion: 1, artifactVersion: manifest.artifactVersion, deployable: false, sourceReplayVerified: true, isolatedOfflineLockedWasmBuild: true, nativeSyntheticBrowserReopenPassed: result.nativeReopenedInWasm, cloudPersistenceVerified: false, pptxFidelityVerified: false, independentBitIdenticalRebuildVerified: false, protectedMarksReplaced: false, fullNoticeContentAuditComplete: false, compilerGeneratedNoticeAuditComplete: false, originalDockerAttachmentTimedOut: execution.initialAttachmentTimedOut, dockerWaitExitStatus: execution.containerExitStatus, initialFailures: execution.initialFailures, localArtifacts: { build, browser, stage }, retained }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(join(output, "result.json"));

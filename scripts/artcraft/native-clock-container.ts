import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import authority from "../../tooling/artcraft/runtime-deckcraft-v2.json" with { type: "json" };
import tools from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { readAcquisitionFile } from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const record = z.object({
  path: relativePath,
  bytes: z.number().int().nonnegative(),
  sha256: digest,
});

const [, , previousStageArgument, toolsArgument, destination] = process.argv;

if (!previousStageArgument || !toolsArgument || !destination || process.argv.length !== 5)
  throw new Error(
    "Usage: bun --no-env-file scripts/artcraft/native-clock-container.ts VERIFIED_OLD_DECK_STAGE PINNED_TOOLS NEW_PROBE_STAGE",
  );

const previousStage = resolve(previousStageArgument);
const toolRoot = resolve(toolsArgument);
const stage = resolve(destination);

for (const path of [previousStage, toolRoot, stage])
  if (/[\n,]/.test(path)) throw new Error("Unsafe container mount path");

const buildBytes = await readFile(
  join("tooling/artcraft", authority.receiptRoot, "build-manifest.json"),
);

if (sha256(buildBytes) !== authority.buildManifestSha256)
  throw new Error("Retained build authority changed");

const build = z.object({ builtInputsSha256: digest }).parse(JSON.parse(buildBytes.toString()));
const planBytes = await readFile(join(previousStage, "build-inputs.json"));

if (sha256(planBytes) !== build.builtInputsSha256)
  throw new Error("Previous public input plan is not the retained .2 source plan");

const previous = z.object({ files: z.array(record) }).parse(JSON.parse(planBytes.toString()));
const bunBytes = await readFile(join(toolRoot, "bin/bun"));

if (bunBytes.length !== tools.bun.bytes || sha256(bunBytes) !== tools.bun.sha256)
  throw new Error("Pinned Bun tool changed");

const inspected = Bun.spawn(
  ["docker", "image", "inspect", tools.baseImage, "--format", "{{.Id}}"],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
);

const imageId = (await new Response(inspected.stdout).text()).trim();

if ((await inspected.exited) !== 0 || imageId !== `sha256:${tools.baseImageConfigSha256}`)
  throw new Error("Approved compiler image is unavailable or changed; no pull attempted");

await mkdir(stage);

for (const path of ["input/probe/src", "driver", "work", "output"])
  await mkdir(join(stage, path), { recursive: true });

const inputs: z.infer<typeof record>[] = [];

async function retain(path: string, bytes: Buffer) {
  await mkdir(dirname(join(stage, "input", path)), { recursive: true });
  await writeFile(join(stage, "input", path), bytes, { flag: "wx" });
  inputs.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

let cacheBytes = 0;

for (const file of previous.files) {
  if (!file.path.startsWith("cargo/registry/") && !file.path.startsWith("cargo/git/db/egui-"))
    continue;
  cacheBytes += file.bytes;

  if (file.bytes > 512 * 1024 * 1024 || cacheBytes > 1024 * 1024 * 1024)
    throw new Error("Public probe cache bound exceeded");
  const bytes = await readAcquisitionFile(join(previousStage, "input"), file.path);

  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error(`Retained public cache changed: ${file.path}`);
  await retain(file.path, bytes);
}

if (!inputs.some((file) => file.path.startsWith("cargo/git/db/egui-")))
  throw new Error("Pinned egui Git cache missing");

const dependency =
  '{ git = "https://github.com/storytold/egui.git", rev = "6d518fc799681571963842f95b55a6b68431b15a" }';

const cargo = `[package]\nname = "hyori-native-clock-probe"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n\n[dependencies]\negui = { git = "https://github.com/storytold/egui.git", rev = "6d518fc799681571963842f95b55a6b68431b15a", default-features = false }\n\n[patch.crates-io]\n${["ecolor", "emath", "epaint", "epaint_default_fonts"].map((name) => `${name} = ${dependency}`).join("\n")}\n`;

await retain("probe/Cargo.toml", Buffer.from(cargo));

await retain(
  "probe/src/lib.rs",
  Buffer.from(
    '#![forbid(unsafe_code)]\nextern crate egui;\ntype NativeHostApp = ();\ninclude!("native-types.rs");\nmod clock;\n',
  ),
);

await retain(
  "probe/src/native-types.rs",
  await readFile("tooling/artcraft/patches/native-host-v3/native-types.rs"),
);

await retain(
  "probe/src/clock.rs",
  await readFile("tooling/artcraft/patches/native-host-v3/native-clock.rs"),
);

const compiled = await Bun.build({
  entrypoints: ["scripts/artcraft/native-clock-driver.ts"],
  target: "bun",
  format: "esm",
});

if (!compiled.success || compiled.outputs.length !== 1)
  throw new Error("Authored native-clock driver bundle failed");

const driver = Buffer.from(await compiled.outputs[0]!.arrayBuffer());

await writeFile(join(stage, "driver/driver.js"), driver, { flag: "wx" });

const container = `hyori-native-clock-${randomUUID()}`;

const args = [
  "docker",
  "run",
  "--rm",
  "--pull",
  "never",
  "--name",
  container,
  "--platform",
  "linux/amd64",
  "--network",
  "none",
  "--user",
  "1000:1000",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges=true",
  "--pids-limit",
  "256",
  "--memory",
  "5g",
  "--cpus",
  "3",
  "--mount",
  `type=bind,src=${join(stage, "input")},dst=/input,readonly`,
  "--mount",
  `type=bind,src=${join(stage, "driver")},dst=/driver,readonly`,
  "--mount",
  `type=bind,src=${join(stage, "work")},dst=/work`,
  "--mount",
  `type=bind,src=${join(stage, "output")},dst=/output`,
  "--mount",
  `type=bind,src=${toolRoot},dst=/tools,readonly`,
  "--workdir",
  "/driver",
  "--env",
  "HOME=/work/home",
  "--entrypoint",
  "/tools/bin/bun",
  tools.baseImage,
  "--no-env-file",
  "--no-install",
  "/driver/driver.js",
];

const receipt = {
  schemaVersion: 1,
  purpose: "native-clock-unit-compilation-only",
  fullEngineBuild: false,
  sourceRevision: "6d518fc799681571963842f95b55a6b68431b15a",
  sourcePlanSha256: build.builtInputsSha256,
  baseImage: tools.baseImage,
  imageId,
  rustVersion: tools.rustVersion,
  rustCommit: tools.rustCommit,
  driverSha256: sha256(driver),
  bunSha256: tools.bun.sha256,
  inputs,
  args,
  jobs: 2,
  memoryBytes: 5 * 1024 * 1024 * 1024,
  cpus: 3,
  pids: 256,
  network: "none",
  unprivileged: true,
  noWholeRepositoryMount: true,
  noSecretsOrSocketMounts: true,
  ownProbeLockGeneratedOfflineThenTestsLocked: true,
};

await writeFile(join(stage, "probe-inputs.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: "wx",
});

console.log(`Prepared ${inputs.length} verified public/authored files; starting ONLY ${container}`);

const started = Date.now();

const child = Bun.spawn(args, {
  stdin: "ignore",
  stdout: Bun.file(join(stage, "output/container.stdout")),
  stderr: Bun.file(join(stage, "output/container.stderr")),
});

const status = await child.exited;

await writeFile(
  join(stage, "output/container-result.json"),
  `${JSON.stringify({ status, elapsedMs: Date.now() - started, container }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(`Native clock container exit ${status}; retained ${join(stage, "output")}`);

process.exitCode = status;

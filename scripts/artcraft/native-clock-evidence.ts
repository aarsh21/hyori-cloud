import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readAcquisitionFile } from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , stageArgument, destination] = process.argv;

if (!stageArgument || !destination || process.argv.length !== 4)
  throw new Error(
    "Usage: bun --no-env-file scripts/artcraft/native-clock-evidence.ts COMPLETED_PROBE_STAGE NEW_RECEIPT",
  );

const stage = resolve(stageArgument);
const output = resolve(destination);
const planBytes = await readAcquisitionFile(stage, "probe-inputs.json");

const plan = z
  .object({
    purpose: z.literal("native-clock-unit-compilation-only"),
    fullEngineBuild: z.literal(false),
    sourceRevision: z.literal("6d518fc799681571963842f95b55a6b68431b15a"),
    driverSha256: digest,
    inputs: z.array(
      z.object({ path: relativePath, bytes: z.number().int().nonnegative(), sha256: digest }),
    ),
    jobs: z.literal(2),
    network: z.literal("none"),
    unprivileged: z.literal(true),
    noWholeRepositoryMount: z.literal(true),
    noSecretsOrSocketMounts: z.literal(true),
  })
  .parse(JSON.parse(planBytes.toString()));

for (const file of plan.inputs) {
  const bytes = await readAcquisitionFile(join(stage, "input"), file.path);

  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error(`Native probe input changed: ${file.path}`);
}

const driver = await readAcquisitionFile(join(stage, "driver"), "driver.js");

if (sha256(driver) !== plan.driverSha256) throw new Error("Native probe driver changed");

const retained = new Map<string, Buffer>([
  ["probe-inputs.json", planBytes],
  ["driver.js", driver],
]);

const commands = [];

for (const id of [
  "rustc",
  "cargo-test-help",
  "cargo-lock-help",
  "generate-lock",
  "native-clock-tests",
  "metadata",
  "features",
]) {
  const resultBytes = await readAcquisitionFile(join(stage, "output"), `${id}.result.json`);

  const result = z
    .object({ status: z.literal(0), elapsedMs: z.number().nonnegative() })
    .parse(JSON.parse(resultBytes.toString()));

  commands.push({ id, ...result });

  for (const suffix of ["command.json", "stdout", "stderr", "result.json"])
    retained.set(
      `${id}.${suffix}`,
      await readAcquisitionFile(join(stage, "output"), `${id}.${suffix}`),
    );
}

const stdout = retained.get("native-clock-tests.stdout")!.toString();

if (
  !stdout.includes("test result: ok. 5 passed; 0 failed") ||
  !retained.get("rustc.stdout")!.includes(Buffer.from("58cf8f9c35b355199727627d07ae34a4e2846d67"))
)
  throw new Error("Native probe actual compiler/test result mismatch");

const metadata = z
  .object({
    packages: z.array(
      z.object({ name: z.string(), version: z.string(), source: z.string().nullable() }),
    ),
  })
  .parse(JSON.parse(retained.get("metadata.stdout")!.toString()));

const eguiPackages = metadata.packages.filter((pkg) =>
  pkg.source?.includes("github.com/storytold/egui.git"),
);

if (
  !["egui", "epaint", "ecolor", "emath"].every((name) =>
    eguiPackages.some(
      (pkg) => pkg.name === name && pkg.source?.endsWith(`#${plan.sourceRevision}`),
    ),
  )
)
  throw new Error("Native probe did not resolve the actual pinned egui type family");

for (const name of [
  "container.stdout",
  "container.stderr",
  "container-result.json",
  "driver-complete.json",
  "Cargo.lock",
])
  retained.set(name, await readAcquisitionFile(join(stage, "output"), name));

z.object({ status: z.literal(0) }).parse(
  JSON.parse(retained.get("container-result.json")!.toString()),
);

z.object({ status: z.literal(0), fullEngineBuild: z.literal(false) }).parse(
  JSON.parse(retained.get("driver-complete.json")!.toString()),
);

for (const name of ["Cargo.toml", "src/lib.rs", "src/native-types.rs", "src/clock.rs"])
  retained.set(
    name.replaceAll("/", "-"),
    await readAcquisitionFile(join(stage, "input/probe"), name),
  );

const currentClock = await readFile("tooling/artcraft/patches/native-host-v3/native-clock.rs");

await mkdir(output);

const files = [];

for (const [path, body] of retained) {
  await writeFile(join(output, path), body, { flag: "wx" });
  files.push({ path, bytes: body.length, sha256: sha256(body) });
}

const receipt = {
  schemaVersion: 1,
  kind: "native-clock-restricted-unit-probe",
  sourcePlanSha256: sha256(planBytes),
  inputFilesVerified: plan.inputs.length,
  commands,
  eguiPackages,
  testsPassed: 5,
  testsFailed: 0,
  exactCurrentClockSource: currentClock.equals(retained.get("src-clock.rs")!),
  fullEngineBuild: false,
  fourNativeAdaptersCompiled: false,
  realBrowserNativeProtocol2Acceptance: false,
  productLaunchAcceptance: false,
  warnings: [
    "Unused epaint_default_fonts patch with this probe's default-features=false selection",
    "Unused generic snapshot/clock items in the minimal harness; exact compiler stderr retained",
  ],
  files,
};

const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);

await writeFile(join(output, "receipt.json"), bytes, { flag: "wx" });

console.log(
  JSON.stringify(
    {
      receipt: join(output, "receipt.json"),
      sha256: sha256(bytes),
      testsPassed: 5,
      fullEngineBuild: false,
    },
    null,
    2,
  ),
);

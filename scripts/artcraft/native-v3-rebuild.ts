import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import bb6 from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };
import deckFonts from "../../tooling/artcraft/patches/native-host-v3/deck-fonts.json" with { type: "json" };
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256 } from "./evidence-bytes.ts";
import { currentNativeRevision } from "./native-v3-runtime.ts";
import { nativeApps } from "./native-v3-source.ts";

/**
 * One command from pinned public inputs to a checked native v3 bundle for the current authority
 * revision (the last entry in native-v3-runtime.ts). Every step is resumable: a step whose result
 * already exists is skipped, and a failed step's partial output is removed before it reruns.
 *
 *   bun scripts/artcraft/native-v3-rebuild.ts [WORK_DIR]
 *
 * Network is used only to fetch pinned inputs; every build runs offline in the pinned container.
 */
const repository = resolve(import.meta.dir, "../..");

const work = resolve(
  process.argv[2] ?? join(repository, "tooling/artcraft/.generated/native-v3-rebuild"),
);

const bun = process.execPath;
const downloads = join(work, "downloads");
const tools = join(work, "tools");
const cargoHome = join(work, "cargo-home");
const fonts = join(work, "craft-fonts");
const logs = join(work, "logs");

async function exists(path: string) {
  try {
    await lstat(path);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function run(name: string, command: string[]) {
  console.log(`→ ${name}`);
  const started = Date.now();

  const child = Bun.spawn(command, {
    cwd: repository,
    stdin: "ignore",
    stdout: Bun.file(join(logs, `${name}.stdout`)),
    stderr: Bun.file(join(logs, `${name}.stderr`)),
  });

  const status = await child.exited;

  if (status !== 0)
    throw new Error(`${name} exited ${status}; see ${join(logs, `${name}.stderr`)}`);
  console.log(`  ${name}: ${Math.round((Date.now() - started) / 1000)} s`);
}

/** Runs `step` unless `done` exists; a failed attempt leaves nothing behind for the next run. */
async function step(name: string, done: string, outputs: string[], body: () => Promise<void>) {
  if (await exists(done)) return console.log(`✓ ${name} (done)`);

  for (const output of outputs) await rm(output, { recursive: true, force: true });

  try {
    await body();
  } catch (cause) {
    for (const output of outputs) await rm(output, { recursive: true, force: true });
    throw cause;
  }

  if (!(await exists(done))) throw new Error(`${name} finished without ${done}`);
}

async function pinned(path: string, url: string, expected: string) {
  if ((await exists(path)) && sha256(await readFile(path)) === expected) return;
  await writeFile(path, await fetchBuildInput(url, expected, 512 * 1024 * 1024));
}

await mkdir(downloads, { recursive: true });

await mkdir(logs, { recursive: true });

const revision = currentNativeRevision;

console.log(`Native v3 ${revision.authority} → tooling/artcraft/.generated/${revision.bundle}`);

// 1. Pinned public inputs: release ZIPs, tagged sources, Inter faces, tools, Rust image, crates.
for (const editor of official.editors) {
  await pinned(join(downloads, `${editor.app}-release.zip`), editor.url, editor.sha256);
  await pinned(
    join(downloads, `${editor.app}-source.tar.gz`),
    editor.sourceUrl,
    editor.sourceSha256,
  );
}

for (const file of [
  ...deckFonts.faces.map((face) => ({ path: face.path, sha256: face.sha256 })),
  { path: deckFonts.licenseFile, sha256: deckFonts.licenseSha256 },
]) {
  await mkdir(join(fonts, file.path, ".."), { recursive: true });
  await pinned(join(fonts, file.path), `${deckFonts.source.rawBase}${file.path}`, file.sha256);
}

await step("tools", join(tools, "tool-inputs.json"), [tools], () =>
  run("tools", [bun, "scripts/artcraft/deckcraft-tools.ts", tools, bun]),
);

const inspect = Bun.spawnSync([
  "docker",
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  pins.baseImage,
]);

if (inspect.stdout.toString().trim() !== `sha256:${pins.baseImageConfigSha256}`)
  await run("image", ["docker", "pull", "--platform", pins.platform, pins.baseImage]);

if (
  Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", pins.baseImage])
    .stdout.toString()
    .trim() !== `sha256:${pins.baseImageConfigSha256}`
)
  throw new Error("Pinned Rust image config differs");

// Public crates and locked Git sources only, fetched with an empty Cargo home. The tagged sources
// unpack inside the container; nothing from them runs, and Cargo.lock pins every checksum.
await step("cargo-fetch", join(cargoHome, "fetched"), [cargoHome], async () => {
  await mkdir(cargoHome);
  await run("cargo-fetch", [
    "docker",
    "run",
    "--rm",
    "--pull",
    "never",
    "--platform",
    pins.platform,
    "--name",
    `hyori-artcraft-fetch-${crypto.randomUUID()}`,
    "--user",
    `${process.getuid!()}:${process.getgid!()}`,
    "--read-only",
    "--tmpfs",
    "/tmp:exec,size=2g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--memory",
    "3g",
    "--cpus",
    "4",
    "--env",
    "CARGO_HOME=/cargo",
    "--env",
    "HOME=/tmp",
    "--mount",
    `type=bind,src=${cargoHome},dst=/cargo`,
    "--mount",
    `type=bind,src=${downloads},dst=/downloads,readonly`,
    "--entrypoint",
    "sh",
    pins.baseImage,
    "-c",
    "set -e; for app in wordcraft gridcraft pdfcraft deckcraft; do mkdir /tmp/$app; tar -xzf /downloads/$app-source.tar.gz -C /tmp/$app --no-same-owner; cargo fetch --locked --manifest-path /tmp/$app/*/Cargo.toml; done; touch /cargo/fetched",
  ]);
});

// 2. The all4-v2 legal base: official acquisition, modified Deck .2, then the bb6 composition.
const acquired = join(work, "acquired");
const archives = join(work, "archives.json");

await writeFile(
  archives,
  JSON.stringify({
    editors: official.editors.map((editor) => ({
      app: editor.app,
      releaseArchive: join(downloads, `${editor.app}-release.zip`),
      sourceArchive: join(downloads, `${editor.app}-source.tar.gz`),
    })),
  }),
);

await step("acquire", join(acquired, "artifact-manifest.json"), [acquired], () =>
  run("acquire", [bun, "scripts/artcraft/content-acquire.ts", acquired, archives]),
);

const deckStage = join(work, "stage/deckcraft-host-v2");
const deckEvidence = join(work, "evidence/deckcraft-host-v2");

await mkdir(join(work, "stage"), { recursive: true });

await mkdir(join(work, "evidence"), { recursive: true });

await step(
  "deck2-build",
  join(deckStage, "output/container-result.json"),
  [deckStage],
  async () => {
    await run("deck2-prepare", [
      bun,
      "scripts/artcraft/deckcraft-build.ts",
      deckStage,
      cargoHome,
      tools,
      join(downloads, "deckcraft-source.tar.gz"),
      "--marks",
    ]);
    await run("deck2-container", [
      bun,
      "scripts/artcraft/deckcraft-container.ts",
      deckStage,
      tools,
    ]);
  },
);

await step("deck2-evidence", join(deckEvidence, "manifest.json"), [deckEvidence], () =>
  run("deck2-evidence", [
    bun,
    "scripts/artcraft/deckcraft-build-evidence.ts",
    deckStage,
    deckEvidence,
    tools,
  ]),
);

const base = join(work, "runtime-all4-v2");

await step("base", join(base, "runtime-bundle-manifest.json"), [base], () =>
  run("base", [
    bun,
    "scripts/artcraft/content-runtime.ts",
    "assemble",
    base,
    acquired,
    deckEvidence,
  ]),
);

await run("base-check", [
  bun,
  "scripts/artcraft/content-runtime.ts",
  "check",
  base,
  bb6.manifestSha256,
]);

// 3. The four native editors, one container at a time.
for (const app of nativeApps) {
  const stage = join(work, `stage/${app}`);
  const evidence = join(work, `evidence/${app}`);
  const source = join(downloads, `${app}-source.tar.gz`);

  await step(`${app}-build`, join(stage, "container-result.json"), [stage], async () => {
    await run(`${app}-prepare`, [
      bun,
      "scripts/artcraft/native-v3-build.ts",
      app,
      stage,
      cargoHome,
      tools,
      source,
      ...(app === "deckcraft" ? [fonts] : []),
    ]);
    await run(`${app}-container`, [bun, "scripts/artcraft/native-v3-container.ts", stage, tools]);
  });
  await step(`${app}-evidence`, join(evidence, "receipt.json"), [evidence], () =>
    run(`${app}-evidence`, [
      bun,
      "scripts/artcraft/native-v3-build-evidence.ts",
      stage,
      evidence,
      tools,
      source,
    ]),
  );
}

// 4. Authority and receipts (committed), bundle and its handoff, then the independent check.
const evidenceRoot = join(work, "evidence");

if (!(await exists(join(repository, "tooling/artcraft", revision.authority))))
  await run("record", [bun, "scripts/artcraft/native-v3-runtime.ts", "record", evidenceRoot]);

const bundle = join(repository, "tooling/artcraft/.generated", revision.bundle);

if (!(await exists(bundle)))
  await run("assemble", [
    bun,
    "scripts/artcraft/native-v3-runtime.ts",
    "assemble",
    bundle,
    base,
    evidenceRoot,
  ]);

const handoff = JSON.parse(
  await readFile(join(repository, "tooling/artcraft", revision.handoff), "utf8"),
);

await run("check", [
  bun,
  "scripts/artcraft/native-v3-runtime.ts",
  "check",
  bundle,
  handoff.manifestSha256,
]);

console.log(
  JSON.stringify(
    {
      bundle,
      manifestSha256: handoff.manifestSha256,
      handoff: `tooling/artcraft/${revision.handoff}`,
    },
    null,
    2,
  ),
);

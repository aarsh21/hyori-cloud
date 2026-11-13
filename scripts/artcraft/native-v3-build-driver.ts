import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

// Authored driver, bundled from the trusted repository and never loaded from vendor source.
// Generalizes deckcraft-build-driver.ts; each app gets its own absolute root so builds can run
// side by side under the same pinned /tools and Rust toolchain paths.
const app = process.argv[2];

if (!app || !["wordcraft", "gridcraft", "pdfcraft", "deckcraft"].includes(app))
  throw new Error("Usage: driver.js wordcraft|gridcraft|pdfcraft|deckcraft");

const root = `/hyori-native-v3/${app}`;
const toolchain = "/usr/local/rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin";
const cargo = `${toolchain}/cargo`;
const rustc = `${toolchain}/rustc`;
const manifest = `${root}/work/source/apps/${app}-web/Cargo.toml`;

const environment = {
  PATH: `/tools/bin:${toolchain}:/usr/bin:/bin`,
  HOME: `${root}/work/home`,
  TMPDIR: `${root}/work/tmp`,
  CARGO_HOME: `${root}/work/cargo`,
  CARGO_TARGET_DIR: `${root}/work/target`,
  RUSTUP_HOME: "/usr/local/rustup",
  RUSTUP_TOOLCHAIN: "1.99.1-x86_64-unknown-linux-gnu",
  RUSTC: rustc,
  RUSTC_WRAPPER: "",
  RUSTC_WORKSPACE_WRAPPER: "",
  CARGO_BUILD_JOBS: "5",
  CARGO_NET_OFFLINE: "true",
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "--sysroot=/tools/wasm-sysroot",
  TRUNK_TOOLS_WASM_BINDGEN: "0.2.129",
  TRUNK_TOOLS_WASM_OPT: "version_123",
  SOURCE_DATE_EPOCH: "1793836800",
  TZ: "UTC",
  LANG: "C.UTF-8",
};

// Deck embeds the pinned Inter faces through upstream's own craft-fonts build input.
if (app === "deckcraft")
  Object.assign(environment, { CRAFT_FONTS_DIR: `${root}/input/craft-fonts` });

async function run(id: string, command: string[]) {
  await writeFile(
    `${root}/output/${id}.command.json`,
    JSON.stringify({ command, cwd: `${root}/driver`, environment }, null, 2),
  );
  const started = Date.now();

  const child = Bun.spawn(command, {
    cwd: `${root}/driver`,
    env: environment,
    stdout: Bun.file(`${root}/output/${id}.stdout`),
    stderr: Bun.file(`${root}/output/${id}.stderr`),
    stdin: "ignore",
  });

  const status = await child.exited;
  await writeFile(
    `${root}/output/${id}.result.json`,
    JSON.stringify({ status, elapsedMs: Date.now() - started }, null, 2),
  );
  console.log(`${app} ${id}: exit ${status} after ${Date.now() - started} ms`);

  if (status !== 0) throw new Error(`${id} failed; see retained stderr`);
}

try {
  for (const directory of ["home", "tmp", "source", "cargo", "target"])
    await mkdir(`${root}/work/${directory}`, { recursive: true });
  await cp(`${root}/input/source`, `${root}/work/source`, { recursive: true });
  await cp(`${root}/input/cargo`, `${root}/work/cargo`, { recursive: true });
  await run("rustc", [rustc, "--version", "--verbose"]);
  await run("cargo-build", [
    cargo,
    "build",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "-p",
    `${app}-web`,
  ]);
  await run("metadata", [
    cargo,
    "metadata",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--filter-platform",
    "wasm32-unknown-unknown",
    "--format-version",
    "1",
  ]);

  const tree = [
    cargo,
    "tree",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--target",
    "wasm32-unknown-unknown",
    "-p",
    `${app}-web`,
    "--prefix",
    "depth",
    "--format",
    "{p}\\t{f}\\t{l}",
    "--charset",
    "ascii",
  ];

  await run("normal-tree", [...tree, "--edges", "normal,no-proc-macro"]);
  await run("host-tree", [...tree, "--edges", "normal,build"]);
  await run("trunk", [
    "/tools/bin/trunk",
    "--config",
    `${root}/work/source/apps/${app}-web/Trunk.toml`,
    "--skip-version-check",
    "--offline=true",
    "build",
    "--release=true",
    "--locked=true",
    "--dist",
    `${root}/work/dist`,
    "--public-url",
    "./",
  ]);
  // The opaque frame receives the descriptor's size/SHA-256-verified WASM from its host.
  // Trunk's speculative fetch cannot enter that cache and downloads a second, unused engine.
  // Keep every script preload (and its SRI); remove only this redundant WASM hint.
  const index = `${root}/work/dist/index.html`;
  const html = await readFile(index, "utf8");

  const wasmHint =
    /<link rel="preload" href="\.\/[a-z]+-web-[a-f0-9]+_bg\.wasm"[^>]*as="fetch" type="application\/wasm">/gu;

  if ([...html.matchAll(wasmHint)].length !== 1)
    throw new Error("Expected exactly one Trunk WASM preload");
  await writeFile(index, html.replace(wasmHint, ""));
  await cp(`${root}/work/dist`, `${root}/output/dist`, { recursive: true });
  await writeFile(`${root}/output/Cargo.lock`, await readFile(`${root}/work/source/Cargo.lock`));
  console.log(`${app} build completed: ${(await readdir(`${root}/output/dist`)).join(", ")}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

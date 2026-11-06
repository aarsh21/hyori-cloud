import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";

// This authored driver is bundled separately from, and never loaded from, vendor source.
const cargo = "/usr/local/rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin/cargo";
const rustc = "/usr/local/rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin/rustc";
const manifest = "/work/source/apps/deckcraft-web/Cargo.toml";

const environment = {
  PATH: "/tools/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/work/home",
  TMPDIR: "/work/tmp",
  CARGO_HOME: "/work/cargo",
  CARGO_TARGET_DIR: "/work/target",
  RUSTUP_HOME: "/usr/local/rustup",
  RUSTUP_TOOLCHAIN: "1.99.1-x86_64-unknown-linux-gnu",
  RUSTC: rustc,
  RUSTC_WRAPPER: "",
  RUSTC_WORKSPACE_WRAPPER: "",
  CARGO_BUILD_JOBS: "2",
  CARGO_NET_OFFLINE: "true",
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "--sysroot=/tools/wasm-sysroot",
  TRUNK_TOOLS_WASM_BINDGEN: "0.2.129",
  TRUNK_TOOLS_WASM_OPT: "version_123",
  SOURCE_DATE_EPOCH: "1793836800",
  TZ: "UTC",
  LANG: "C.UTF-8",
};

async function run(id: string, command: string[]) {
  await writeFile(
    `/output/${id}.command.json`,
    JSON.stringify({ command, cwd: "/driver", environment }, null, 2),
  );
  const out = Bun.file(`/output/${id}.stdout`);
  const err = Bun.file(`/output/${id}.stderr`);
  const started = Date.now();

  const child = Bun.spawn(command, {
    cwd: "/driver",
    env: environment,
    stdout: out,
    stderr: err,
    stdin: "ignore",
  });

  const status = await child.exited;
  await writeFile(
    `/output/${id}.result.json`,
    JSON.stringify({ status, elapsedMs: Date.now() - started }, null, 2),
  );
  console.log(`${id}: exit ${status}`);

  if (status !== 0) throw new Error(`${id} failed; see retained stderr`);
}

try {
  for (const directory of ["home", "tmp", "source", "cargo", "target"])
    await mkdir(`/work/${directory}`, { recursive: true });
  await cp("/input/source", "/work/source", { recursive: true });
  await cp("/input/cargo", "/work/cargo", { recursive: true });
  // Cargo/Trunk receive explicit manifests/configs; no upstream installer or packaging script.
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
    "deckcraft-web",
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
    "deckcraft-web",
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
    "/work/source/apps/deckcraft-web/Trunk.toml",
    "--skip-version-check",
    "--offline=true",
    "build",
    "--release=true",
    "--locked=true",
    "--dist",
    "/work/dist",
    "--public-url",
    "./",
  ]);
  await cp("/work/dist", "/output/dist", { recursive: true });
  // Retain the exact lock used, not merely the tagged recipe's declared lock.
  await writeFile("/output/Cargo.lock", await readFile("/work/source/Cargo.lock"));
  console.log(`Build completed: ${(await readdir("/output/dist")).join(", ")}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

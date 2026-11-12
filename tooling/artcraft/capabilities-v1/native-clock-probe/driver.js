// @bun
// scripts/artcraft/native-clock-driver.ts
import { cp, mkdir, readFile, writeFile } from "fs/promises";
var cargo = "/usr/local/rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin/cargo";
var rustc = "/usr/local/rustup/toolchains/1.99.1-x86_64-unknown-linux-gnu/bin/rustc";
var manifest = "/work/probe/Cargo.toml";
var environment = {
  PATH: "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/work/home",
  TMPDIR: "/work/tmp",
  CARGO_HOME: "/work/cargo",
  CARGO_TARGET_DIR: "/work/target",
  CARGO_BUILD_JOBS: "2",
  CARGO_NET_OFFLINE: "true",
  RUSTUP_HOME: "/usr/local/rustup",
  RUSTUP_TOOLCHAIN: "1.99.1-x86_64-unknown-linux-gnu",
  RUSTC: rustc,
  RUSTC_WRAPPER: "",
  RUSTC_WORKSPACE_WRAPPER: "",
  SOURCE_DATE_EPOCH: "1793836800",
  LANG: "C.UTF-8",
  TZ: "UTC"
};
async function run(id, command) {
  await writeFile(`/output/${id}.command.json`, JSON.stringify({ command, cwd: "/driver", environment }, null, 2));
  const started = Date.now();
  const child = Bun.spawn(command, {
    cwd: "/driver",
    env: environment,
    stdin: "ignore",
    stdout: Bun.file(`/output/${id}.stdout`),
    stderr: Bun.file(`/output/${id}.stderr`)
  });
  const status = await child.exited;
  await writeFile(`/output/${id}.result.json`, JSON.stringify({ status, elapsedMs: Date.now() - started }, null, 2));
  console.log(`${id}: exit ${status}`);
  if (status !== 0)
    throw new Error(`${id} failed; exact output retained`);
}
try {
  for (const path of ["home", "tmp", "cargo", "target", "probe"])
    await mkdir(`/work/${path}`, { recursive: true });
  await cp("/input/cargo", "/work/cargo", { recursive: true });
  await cp("/input/probe", "/work/probe", { recursive: true });
  await run("rustc", [rustc, "--version", "--verbose"]);
  const compiler = await readFile("/output/rustc.stdout", "utf8");
  if (!compiler.includes("rustc 1.99.1") || !compiler.includes("58cf8f9c35b355199727627d07ae34a4e2846d67"))
    throw new Error("Native clock compiler pin mismatch");
  await run("cargo-test-help", [cargo, "test", "--help"]);
  await run("cargo-lock-help", [cargo, "generate-lockfile", "--help"]);
  await run("generate-lock", [
    cargo,
    "generate-lockfile",
    "--manifest-path",
    manifest,
    "--offline"
  ]);
  await cp("/work/probe/Cargo.lock", "/output/Cargo.lock");
  await run("native-clock-tests", [
    cargo,
    "test",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--jobs",
    "2"
  ]);
  await run("metadata", [
    cargo,
    "metadata",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--format-version",
    "1"
  ]);
  await run("features", [
    cargo,
    "tree",
    "--manifest-path",
    manifest,
    "--locked",
    "--offline",
    "--edges",
    "features"
  ]);
  await writeFile("/output/driver-complete.json", JSON.stringify({ status: 0, fullEngineBuild: false, actualPinnedEguiTypes: true }, null, 2));
} catch (cause) {
  await writeFile("/output/driver-failed.txt", String(cause));
  process.exitCode = 1;
}

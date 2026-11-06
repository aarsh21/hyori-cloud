import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runRustContractsCli } from "./generate-rust-contracts.ts";
import { rustBuildConfig } from "./rust-build-config.ts";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const build = rustBuildConfig();
const directory = await mkdtemp(join(tmpdir(), "hyori-contract-export-"));

try {
  const manifest = execFileSync(
    build.executable,
    ["run", "--locked", "--quiet", "--bin", "hyori-contracts"],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: build.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const input = join(directory, "manifest.json");
  await writeFile(input, manifest, { flag: "wx" });
  await runRustContractsCli([
    "--input",
    input,
    "--output",
    "packages/api/src/generated",
    ...(values.check ? ["--check"] : []),
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}

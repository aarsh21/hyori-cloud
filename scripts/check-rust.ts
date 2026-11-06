import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { rustBuildConfig } from "./rust-build-config.ts";

const { values } = parseArgs({ options: { services: { type: "boolean", default: false } } });
const build = rustBuildConfig();

const commands = values.services
  ? [
      ["test", "-p", "hyori-server", "--locked", "--", "--ignored", "--nocapture"],
      [
        "test",
        "-p",
        "hyori-storage",
        "--locked",
        "--test",
        "rustfs",
        "--",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
      ],
    ]
  : [
      ["fmt", "--all", "--", "--check"],
      [
        "clippy",
        "--workspace",
        "--all-targets",
        "--all-features",
        "--locked",
        "--",
        "-D",
        "warnings",
      ],
      ["test", "--workspace", "--locked"],
    ];

for (const args of commands) {
  process.stdout.write(`cargo ${args.join(" ")}\n`);

  const result = spawnSync(build.executable, args, {
    stdio: "inherit",
    env: {
      ...build.env,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2",
      // Generated AWS test debug symbols are expensive; this changes no runtime validation or tests.
      CARGO_PROFILE_TEST_DEBUG: process.env.CARGO_PROFILE_TEST_DEBUG ?? "0",
    },
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

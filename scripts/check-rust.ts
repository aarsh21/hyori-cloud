import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { rustBuildConfig } from "./rust-build-config.ts";

const { values } = parseArgs({ options: { services: { type: "boolean", default: false } } });
const build = rustBuildConfig();

// These read a built ArtCraft bundle, which only exists where one was assembled; say so rather than abort.
const bundleTests = process.env.HYORI_EDITOR_TEST_BUNDLE_DIR
  ? []
  : [
      "actual_official_bundle_passes_the_runtime_inventory_verifier",
      "actual_bundle_activation_preserves_disable_and_absence_revokes_session_capability",
    ];

if (values.services && bundleTests.length > 0) {
  process.stdout.write(
    `Skipping ${bundleTests.join(", ")}: set HYORI_EDITOR_TEST_BUNDLE_DIR and HYORI_EDITOR_TEST_BUNDLE_SHA256 to run them.\n`,
  );
}

const commands = values.services
  ? [
      [
        "test",
        "-p",
        "hyori-server",
        "--locked",
        "--",
        "--ignored",
        "--nocapture",
        ...bundleTests.flatMap((name) => ["--skip", name]),
      ],
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

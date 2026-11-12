import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { rustBuildConfig } from "./rust-build-config.ts";

const { values } = parseArgs({
  options: {
    services: { type: "boolean", default: false },
    // CI runs the default gates in parallel jobs; without --only every gate runs.
    only: { type: "string", multiple: true },
    // Compile the test binaries without running them, so CI overlaps the compile with fixture setup.
    "no-run": { type: "boolean", default: false },
    // CI spreads the service fixtures over runners: --shard 2/4 runs the second of four parts.
    shard: { type: "string" },
  },
});

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

const serverFixtureArgs = [
  "--",
  "--ignored",
  "--nocapture",
  ...bundleTests.flatMap((name) => ["--skip", name]),
];

const storageFixtures = [
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
];

// Measured CI seconds per fixture suite. They only balance shards; an unlisted suite still runs.
const fixtureSeconds = new Map([
  ["editors", 190],
  ["files_shares", 155],
  ["hyori-storage", 75],
  ["upload_disconnect", 75],
  ["admin", 65],
  ["postgres", 55],
  ["uploads", 40],
  ["media", 30],
  ["upload_contention", 25],
  ["photos", 20],
  ["auth_bounds", 15],
  ["editor_assets", 7],
  ["architecture", 1],
  ["contracts", 1],
  ["credential_boundary", 1],
  ["startup_contracts", 1],
]);

const cargoMetadata = z.object({
  packages: z.array(
    z.object({
      name: z.string(),
      targets: z.array(z.object({ name: z.string(), kind: z.array(z.string()) })),
    }),
  ),
});

function serviceShard(spec: string) {
  const [index, count] = z
    .tuple([z.coerce.number().int().positive(), z.coerce.number().int().positive()])
    .refine(([part, parts]) => part <= parts, "the shard must be one of the parts")
    .parse(spec.split("/"));

  const metadata = cargoMetadata.parse(
    JSON.parse(
      execFileSync(
        build.executable,
        ["metadata", "--no-deps", "--format-version", "1", "--locked"],
        {
          encoding: "utf8",
          env: build.env,
        },
      ),
    ),
  );

  const serverTests =
    metadata.packages
      .find((item) => item.name === "hyori-server")
      ?.targets.filter((target) => target.kind.includes("test"))
      .map((target) => target.name) ?? [];

  const weight = (suite: string) => fixtureSeconds.get(suite) ?? 30;
  const shards = Array.from({ length: count }, () => ({ seconds: 0, suites: new Array<string>() }));

  // Longest first onto the least loaded shard, so every suite lands in exactly one shard.
  for (const suite of ["hyori-storage", ...serverTests].toSorted(
    (left, right) => weight(right) - weight(left) || left.localeCompare(right),
  )) {
    const lightest = shards.reduce((least, shard) =>
      shard.seconds < least.seconds ? shard : least,
    );

    lightest.seconds += weight(suite);
    lightest.suites.push(suite);
  }

  const suites = shards[index - 1]?.suites ?? [];

  const tests = suites
    .filter((suite) => suite !== "hyori-storage")
    .flatMap((name) => ["--test", name]);

  // The first shard also owns the server's lib, bin, example and doc targets.
  const server =
    index === 1
      ? [
          [
            "test",
            "-p",
            "hyori-server",
            "--locked",
            "--lib",
            "--bins",
            "--examples",
            ...tests,
            ...serverFixtureArgs,
          ],
          ["test", "-p", "hyori-server", "--locked", "--doc", ...serverFixtureArgs],
        ]
      : tests.length > 0
        ? [["test", "-p", "hyori-server", "--locked", ...tests, ...serverFixtureArgs]]
        : [];

  return [...server, ...(suites.includes("hyori-storage") ? [storageFixtures] : [])];
}

const serviceCommands = () =>
  values.shard
    ? serviceShard(values.shard)
    : [["test", "-p", "hyori-server", "--locked", ...serverFixtureArgs], storageFixtures];

const commands = values.services
  ? serviceCommands()
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

const only = values.only;
const filtered = only ? commands.filter((args) => only.includes(args[0] ?? "")) : commands;

const selected = values["no-run"]
  ? filtered
      // Cargo cannot compile doctests without running them.
      .filter((args) => args[0] === "test" && !args.includes("--doc"))
      .map((args) => [
        ...args.slice(0, args.includes("--") ? args.indexOf("--") : undefined),
        "--no-run",
      ])
  : filtered;

if (selected.length === 0) throw new Error(`No cargo gate matches --only ${only?.join(", ")}`);

for (const args of selected) {
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

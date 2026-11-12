import { writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { sha256 } from "./evidence-bytes.ts";

const [, , stagingArgument, toolsArgument] = process.argv;

if (!stagingArgument || !toolsArgument || process.argv.length !== 4)
  throw new Error(
    "Usage: bun scripts/artcraft/deckcraft-container.ts PREPARED_STAGING PINNED_TOOLS",
  );

const staging = resolve(stagingArgument);
const tools = resolve(toolsArgument);

for (const directory of ["input", "driver", "work", "output"]) {
  if (!(await lstat(join(staging, directory))).isDirectory())
    throw new Error("Expected dedicated build directory");
}

if ((await readdir(join(staging, "output"))).length)
  throw new Error("Refusing to overwrite an earlier build attempt");

const name = `hyori-deckcraft-${crypto.randomUUID()}`;

const args = [
  "docker",
  "run",
  "--rm",
  "--pull",
  "never",
  "--name",
  name,
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
];

for (const directory of ["input", "driver", "work", "output"])
  args.push(
    "--mount",
    `type=bind,src=${join(staging, directory)},dst=/${directory}${["input", "driver"].includes(directory) ? ",readonly" : ""}`,
  );

args.push(
  "--mount",
  `type=bind,src=${tools},dst=/tools,readonly`,
  "--workdir",
  "/driver",
  "--env",
  "HOME=/work/home",
  "--entrypoint",
  "/tools/bin/bun",
  pins.baseImage,
  "--no-env-file",
  "--no-install",
  "/driver/driver.js",
);

await writeFile(
  join(staging, "output/container-command.json"),
  JSON.stringify(
    {
      args,
      buildInputsSha256: sha256(await readFile(join(staging, "build-inputs.json"))),
      driverSha256: sha256(await readFile(join(staging, "driver/driver.js"))),
      noWholeRepositoryMount: true,
      networkDuringCompilation: false,
    },
    null,
    2,
  ),
  { flag: "wx" },
);

const child = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const status = await child.exited;

await writeFile(
  join(staging, "output/container-result.json"),
  JSON.stringify({ status }, null, 2),
  { flag: "wx" },
);

process.exitCode = status;

import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { sha256 } from "./evidence-bytes.ts";
import { nativeApps } from "./native-v3-source.ts";

/** Resource bounds for one editor build; builds run one at a time so the host stays usable. */
export const nativeContainerLimits = { memory: "6g", cpus: "6", pids: "512" } as const;

/**
 * Runs a prepared native v3 stage in the pinned Rust image: no network, unprivileged, read-only
 * root, dropped capabilities, bounded memory/CPU/processes. The stage mounts at the driver's
 * absolute root and the pinned tools at /tools; the image supplies /usr/local/rustup.
 */
export async function runNativeContainer(stageRoot: string, tools: string) {
  const stage = resolve(stageRoot);

  const plan = z
    .object({ app: z.enum(nativeApps) })
    .parse(JSON.parse(await readFile(join(stage, "build-inputs.json"), "utf8")));

  for (const directory of ["input", "driver", "work", "output"])
    if (!(await lstat(join(stage, directory))).isDirectory())
      throw new Error("Expected dedicated build directory");

  if ((await readdir(join(stage, "output"))).length)
    throw new Error("Refusing to reuse an earlier build attempt");

  const root = `/hyori-native-v3/${plan.app}`;
  const name = `hyori-native-v3-${plan.app}-${crypto.randomUUID()}`;

  const { uid, gid } =
    process.getuid && process.getgid
      ? { uid: process.getuid(), gid: process.getgid() }
      : { uid: 1000, gid: 1000 };

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
    `${uid}:${gid}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    nativeContainerLimits.pids,
    "--memory",
    nativeContainerLimits.memory,
    "--memory-swap",
    nativeContainerLimits.memory,
    "--cpus",
    nativeContainerLimits.cpus,
  ];

  for (const directory of ["input", "driver", "work", "output"])
    args.push(
      "--mount",
      `type=bind,src=${join(stage, directory)},dst=${root}/${directory}${["input", "driver"].includes(directory) ? ",readonly" : ""}`,
    );

  args.push(
    "--mount",
    `type=bind,src=${resolve(tools)},dst=/tools,readonly`,
    "--workdir",
    `${root}/driver`,
    "--entrypoint",
    "/tools/bin/bun",
    pins.baseImage,
    "--no-env-file",
    "--no-install",
    `${root}/driver/driver.js`,
    plan.app,
  );

  await writeFile(
    join(stage, "container-command.json"),
    `${JSON.stringify(
      {
        args,
        buildInputsSha256: sha256(await readFile(join(stage, "build-inputs.json"))),
        driverSha256: sha256(await readFile(join(stage, "driver/driver.js"))),
        limits: nativeContainerLimits,
        noWholeRepositoryMount: true,
        networkDuringCompilation: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );

  const started = Date.now();
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;

  await writeFile(
    join(stage, "container-result.json"),
    `${JSON.stringify({ status, elapsedMs: Date.now() - started }, null, 2)}\n`,
    { flag: "wx" },
  );

  if (status !== 0) throw new Error(`${plan.app} container exited ${status}`);
}

if (import.meta.main) {
  const [, , stage, tools] = process.argv;

  if (!stage || !tools || process.argv.length !== 4)
    throw new Error(
      "Usage: bun scripts/artcraft/native-v3-container.ts PREPARED_STAGING PINNED_TOOLS",
    );
  await runNativeContainer(stage, tools);
}

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { artifactDigest, frontendIdentity } from "./web-host.ts";
import type { WebHost } from "./web-host.ts";

const WEB_PORT = 3001;
const OUTPUT_IN_IMAGE = "/app/.output";
const RUNTIME_MAJOR = "v24.";

/** The fixture's own network, and the backend's name on it. Nothing else about the stack. */
export type WebImageBackend = { readonly network: string; readonly url: string };

export type DockerResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** The one capability this host needs, so its failure paths can be tested without containers. */
export type DockerCli = (args: readonly string[]) => DockerResult;

const realDocker: DockerCli = (args) => {
  const { status, stdout, stderr } = spawnSync("docker", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });

  return { status, stdout, stderr };
};

/** What actually started, read back rather than assumed from the command that started it. */
const RunningContainer = z.looseObject({
  Image: z.string(),
  HostConfig: z.looseObject({
    ReadonlyRootfs: z.boolean(),
    NetworkMode: z.string(),
    CapDrop: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
  }),
  Mounts: z.array(z.unknown()).nullable(),
});

/**
 * The deployment's own web service boundary, from `docker-compose.yml`: no writable root, no
 * capabilities, and a clean environment of public settings. There are deliberately no mounts or env
 * files. The image's own `HOST`, `PORT`, user and command stay what the image says they are.
 */
export function webContainerArgs({
  name,
  imageId,
  origin,
  backend,
}: {
  name: string;
  imageId: string;
  origin: string;
  backend: WebImageBackend;
}) {
  return [
    "run",
    "--detach",
    "--init",
    "--name",
    name,
    "--network",
    backend.network,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--publish",
    `127.0.0.1::${WEB_PORT}`,
    "--env",
    "NODE_ENV=production",
    "--env",
    "APP_ENV=production",
    "--env",
    `APP_ORIGIN=${origin}`,
    "--env",
    `HYORI_BACKEND_URL=${backend.url}`,
    imageId,
  ];
}

/**
 * Runs the exact web image under its own runtime, on the fixture's private network. Only loopback
 * reaches it, through the same TLS gateway as ever. Its files are copied out of a separate stopped
 * container, only to be hashed and searched: nothing from that copy is ever executed.
 *
 * `stop` is registered before `start` is called, so an interrupt mid-start still cleans up.
 */
export function createWebImageHost({
  image,
  origin,
  backend,
  docker = realDocker,
  readyTimeoutMs = 60_000,
}: {
  image: string;
  origin: string;
  backend: WebImageBackend;
  docker?: DockerCli;
  readyTimeoutMs?: number;
}) {
  const suffix = randomBytes(8).toString("hex");
  const name = `hyori-browser-web-${suffix}`;
  const artifactContainer = `hyori-browser-web-artifact-${suffix}`;
  let directory: string | null = null;
  let stopped = false;

  function must(args: readonly string[]) {
    const { status, stdout, stderr } = docker(args);

    if (status !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim().slice(0, 600)}`);

    return stdout.trim();
  }

  function remove(container: string) {
    const { status, stderr } = docker(["rm", "--force", container]);

    if (status !== 0 && !stderr.includes("No such container")) {
      console.error(`Couldn't remove ${container}: ${stderr.trim().slice(0, 300)}`);
    }
  }

  function removeCopy() {
    if (directory === null) return;

    // Whatever modes the image's files came with, this copy is ours to remove.
    spawnSync("chmod", ["-R", "u+w", directory], { stdio: "ignore" });
    rmSync(directory, { recursive: true, force: true });
    directory = null;
  }

  /** Removed by name whatever was reached: a failed `docker run` can still leave one behind. */
  function stop() {
    if (stopped) return;

    stopped = true;

    try {
      remove(name);
      remove(artifactContainer);
    } finally {
      removeCopy();
    }
  }

  const logs = () => {
    const { stdout, stderr } = docker(["logs", "--tail", "60", name]);

    return `${stdout}${stderr}`.slice(0, 6000);
  };

  function copyArtifact(imageId: string) {
    directory = mkdtempSync(join(tmpdir(), "hyori-browser-web-artifact-"));

    const output = join(directory, "output");

    must(["create", "--name", artifactContainer, "--network", "none", imageId]);

    try {
      must(["cp", `${artifactContainer}:${OUTPUT_IN_IMAGE}`, output]);
    } finally {
      remove(artifactContainer);
    }

    return output;
  }

  function publishedUrl() {
    const addresses = must(["port", name, `${WEB_PORT}/tcp`])
      .split("\n")
      .filter((address) => address !== "");

    const [first] = addresses;

    if (first === undefined || !addresses.every((address) => address.startsWith("127.0.0.1:"))) {
      throw new Error(`The web container isn't bound to loopback only: ${addresses.join(", ")}.`);
    }

    return `http://${first}`;
  }

  async function untilAnswering(url: string) {
    const deadline = Date.now() + readyTimeoutMs;

    while (Date.now() < deadline) {
      if (must(["inspect", "--format", "{{.State.Running}}", name]) !== "true") {
        throw new Error(`The web container exited during startup.\n${logs()}`);
      }

      try {
        const response = await fetch(url, {
          headers: { host: new URL(origin).host },
          signal: AbortSignal.timeout(1000),
        });

        await response.body?.cancel();

        if (response.status < 500) return;
      } catch {
        // Not listening yet.
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`The web container never answered.\n${logs()}`);
  }

  function assertBoundary(imageId: string) {
    const running = RunningContainer.parse(
      JSON.parse(must(["inspect", "--format", "{{json .}}", name])),
    );

    const { ReadonlyRootfs, NetworkMode, CapDrop, SecurityOpt } = running.HostConfig;

    if (
      running.Image !== imageId ||
      !ReadonlyRootfs ||
      NetworkMode !== backend.network ||
      !CapDrop?.includes("ALL") ||
      !SecurityOpt?.includes("no-new-privileges") ||
      (running.Mounts?.length ?? 0) > 0
    ) {
      throw new Error("The web container didn't start with the deployment's boundary.");
    }
  }

  async function start(): Promise<WebHost> {
    try {
      const sourceDigest = frontendIdentity();

      // Everything after this uses the ID, so a tag moved mid-run can't change what's tested.
      const webImageId = must(["image", "inspect", "--format", "{{.Id}}", image]);
      const output = copyArtifact(webImageId);

      must(webContainerArgs({ name, imageId: webImageId, origin, backend }));

      const url = publishedUrl();

      await untilAnswering(url);
      assertBoundary(webImageId);

      const webRuntime = must(["exec", name, "node", "--version"]);

      if (!webRuntime.startsWith(RUNTIME_MAJOR)) {
        throw new Error(`The web image runs ${webRuntime}, not Node ${RUNTIME_MAJOR}x.`);
      }

      return {
        url,
        stop,
        backendUrl: backend.url,
        sourceDigest,
        buildDigest: artifactDigest(output),
        nitroDigest: artifactDigest(join(output, "server")),
        publicAssetsDigest: artifactDigest(join(output, "public")),
        webImageId,
        webRuntime,
        publicDirectory: join(output, "public"),
        errors: logs,
      };
    } catch (error) {
      stop();
      throw error;
    }
  }

  return { start, stop };
}

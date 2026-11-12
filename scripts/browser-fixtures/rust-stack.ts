import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { EditorBundle } from "./editor-bundle.ts";
import type { WebImageBackend } from "./web-image-host.ts";

export type RustStack = {
  readonly setupToken: string;
  readonly backendUrl: string;
  /** How a container on this stack's private network reaches the backend, and nothing more. */
  readonly webBackend: WebImageBackend;
  readonly restartServer: (whileStopped?: () => Promise<void>) => Promise<void>;
  /** Stop and start the isolated worker. It has no network, so neither disturbs the host's. */
  readonly stopWorker: () => void;
  readonly startWorker: () => Promise<void>;
  readonly sql: (statement: string) => string;
  readonly serverLogs: () => string;
  readonly stop: () => void;
};

const SERVER_IMAGE_USER = "10001:10001";
const WORKER_SOCKET_DIRECTORY = "/run/hyori-media";
const WORKER_SOCKET = `${WORKER_SOCKET_DIRECTORY}/worker.sock`;
const EDITOR_BUNDLE_MOUNT = "/opt/hyori/artcraft";

async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Still starting. The deadline decides when that stops being acceptable.
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(message);
}

/**
 * The real release image with PostgreSQL 17 and pinned RustFS: uniquely named, on its own network,
 * on tmpfs, with random credentials, so nothing about this run can touch anyone's services or volumes.
 */
export async function startRustStack(
  image: string,
  origin: string,
  backendPort: number,
  workerImage: string | null,
  editorBundle: EditorBundle | null = null,
): Promise<RustStack> {
  const suffix = randomBytes(8).toString("hex");
  const network = `hyori-browser-${suffix}`;
  const postgres = `hyori-browser-pg-${suffix}`;
  const storage = `hyori-browser-storage-${suffix}`;
  const server = `hyori-browser-server-${suffix}`;
  const worker = `hyori-browser-worker-${suffix}`;
  const workerSocketVolume = `hyori-browser-media-${suffix}`;

  const secrets = {
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    HYORI_SETUP_TOKEN: randomBytes(32).toString("hex"),
    HYORI_AUTH_SECRET: randomBytes(32).toString("hex"),
    RUSTFS_ACCESS_KEY: randomBytes(24).toString("hex"),
    RUSTFS_SECRET_KEY: randomBytes(32).toString("hex"),
  };

  const created: string[] = [];
  let createdNetwork = false;
  let createdVolume = false;

  function docker(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return execFileSync("docker", [...args], {
      env: { ...process.env, ...secrets, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }).trim();
  }

  function stop() {
    for (const name of created.splice(0).reverse()) {
      spawnSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
    }

    if (createdVolume)
      spawnSync("docker", ["volume", "rm", workerSocketVolume], { stdio: "ignore" });
    createdVolume = false;

    if (createdNetwork) spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    createdNetwork = false;
  }

  function publishedUrl(name: string, port: number) {
    const address = docker(["port", name, `${port}/tcp`]).split("\n")[0] ?? "";

    if (!address.startsWith("127.0.0.1:")) throw new Error(`${name} is not bound to loopback.`);

    return `http://${address}`;
  }

  try {
    const user = docker(["image", "inspect", "--format", "{{.Config.User}}", image]);

    if (user !== SERVER_IMAGE_USER)
      throw new Error(`${image} doesn't run as ${SERVER_IMAGE_USER}.`);

    docker(["network", "create", network]);
    createdNetwork = true;

    docker([
      "run",
      "--detach",
      "--name",
      postgres,
      "--network",
      network,
      // The server shares this container's network, so restarting it changes nothing on the host.
      // A host interface change fails Chromium's in-flight requests, which isn't what's under test.
      "-p",
      `127.0.0.1:${backendPort}:3002`,
      "--tmpfs",
      "/var/lib/postgresql/data",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_USER=hyori_browser",
      "-e",
      "POSTGRES_DB=hyori_browser",
      "postgres:17",
    ]);
    created.push(postgres);
    await until(
      () => {
        docker(["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "hyori_browser"]);

        return true;
      },
      "PostgreSQL did not become ready.",
      45_000,
    );

    docker([
      "run",
      "--detach",
      "--name",
      storage,
      "--network",
      network,
      "-p",
      "127.0.0.1::9000",
      "--tmpfs",
      "/data:uid=10001,gid=10001",
      "--tmpfs",
      "/logs:uid=10001,gid=10001",
      "-e",
      "RUSTFS_ACCESS_KEY",
      "-e",
      "RUSTFS_SECRET_KEY",
      "-e",
      "RUSTFS_CONSOLE_ENABLE=false",
      "rustfs/rustfs:1.0.0-alpha.85",
      "/data",
    ]);
    created.push(storage);
    const storageUrl = publishedUrl(storage, 9000);

    await until(
      async () => (await fetch(`${storageUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok,
      "RustFS did not become ready.",
      60_000,
    );

    const workerReady = () =>
      until(
        () => {
          docker(["exec", worker, "test", "-S", WORKER_SOCKET]);

          return true;
        },
        "The isolated worker never exposed its private socket.",
        30_000,
      );

    if (workerImage !== null) {
      if (
        docker(["image", "inspect", "--format", "{{.Config.User}}", workerImage]) !==
        SERVER_IMAGE_USER
      ) {
        throw new Error(`${workerImage} doesn't run as ${SERVER_IMAGE_USER}.`);
      }

      docker(["volume", "create", workerSocketVolume]);
      createdVolume = true;

      // The same boundary as the deployment's Compose file: only this new socket volume is shared.
      docker([
        "run",
        "--rm",
        "--user",
        "0:0",
        "--read-only",
        "--network",
        "none",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--cap-add=FOWNER",
        "--security-opt=no-new-privileges",
        "--mount",
        `type=volume,source=${workerSocketVolume},target=${WORKER_SOCKET_DIRECTORY}`,
        "alpine:3.22",
        "sh",
        "-ec",
        `chmod 0700 ${WORKER_SOCKET_DIRECTORY} && chown 10001:10001 ${WORKER_SOCKET_DIRECTORY}`,
      ]);
      docker([
        "run",
        "--detach",
        "--init",
        "--name",
        worker,
        "--user",
        SERVER_IMAGE_USER,
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--cpus=1",
        "--memory=512m",
        "--memory-swap=512m",
        "--pids-limit=64",
        "--tmpfs",
        "/scratch:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700",
        "--mount",
        `type=volume,source=${workerSocketVolume},target=${WORKER_SOCKET_DIRECTORY}`,
        "-e",
        `HYORI_MEDIA_SOCKET=${WORKER_SOCKET}`,
        workerImage,
      ]);
      created.push(worker);
      await workerReady();
    }

    docker(
      [
        "run",
        "--detach",
        "--name",
        server,
        "--network",
        `container:${postgres}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        // The deployment overlay's boundary: one immutable bundle, read-only, pinned by its manifest.
        ...(editorBundle === null
          ? []
          : [
              "--mount",
              `type=bind,source=${editorBundle.directory},target=${EDITOR_BUNDLE_MOUNT},readonly`,
              "-e",
              `HYORI_EDITOR_ASSETS_DIR=${EDITOR_BUNDLE_MOUNT}`,
              "-e",
              `HYORI_EDITOR_ASSETS_MANIFEST_SHA256=${editorBundle.manifestSha256}`,
            ]),
        ...(workerImage === null
          ? []
          : [
              "--mount",
              `type=volume,source=${workerSocketVolume},target=${WORKER_SOCKET_DIRECTORY},readonly`,
              "-e",
              `HYORI_MEDIA_WORKER_SOCKET=${WORKER_SOCKET}`,
            ]),
        "-e",
        "APP_ENV=production",
        "-e",
        `APP_ORIGIN=${origin}`,
        "-e",
        "HYORI_DATABASE_URL",
        "-e",
        "HYORI_SETUP_TOKEN",
        "-e",
        "HYORI_AUTH_SECRET",
        "-e",
        `HYORI_STORAGE_ENDPOINT=http://${storage}:9000`,
        "-e",
        "HYORI_STORAGE_REGION=us-east-1",
        "-e",
        `HYORI_STORAGE_BUCKET=hyori-browser-${suffix}`,
        "-e",
        "HYORI_STORAGE_ACCESS_KEY",
        "-e",
        "HYORI_STORAGE_SECRET_KEY",
        image,
      ],
      {
        HYORI_DATABASE_URL: `postgres://hyori_browser:${secrets.POSTGRES_PASSWORD}@${postgres}:5432/hyori_browser`,
        HYORI_STORAGE_ACCESS_KEY: secrets.RUSTFS_ACCESS_KEY,
        HYORI_STORAGE_SECRET_KEY: secrets.RUSTFS_SECRET_KEY,
      },
    );
    created.push(server);

    const backendUrl = publishedUrl(postgres, 3002);

    const ready = () =>
      until(
        async () => {
          if (docker(["inspect", "--format", "{{.State.Running}}", server]) !== "true") {
            throw new Error("The Rust server exited.");
          }

          return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
            .ok;
        },
        "The Rust release image never reached database-backed readiness.",
        60_000,
      );

    await ready();

    return {
      setupToken: secrets.HYORI_SETUP_TOKEN,
      backendUrl,
      // The server shares PostgreSQL's network identity, so this is that container's name.
      webBackend: { network, url: `http://${postgres}:3002` },
      async restartServer(whileStopped) {
        docker(["stop", "--time", "10", server]);

        try {
          await whileStopped?.();
        } finally {
          docker(["start", server]);
          await ready();
        }
      },
      stopWorker() {
        docker(["stop", "--time", "2", worker]);
      },
      async startWorker() {
        docker(["start", worker]);
        await workerReady();
      },
      sql: (statement) =>
        docker([
          "exec",
          postgres,
          "psql",
          "-U",
          "hyori_browser",
          "-d",
          "hyori_browser",
          "-v",
          "ON_ERROR_STOP=1",
          "-Atc",
          statement,
        ]),
      serverLogs: () => {
        const result = spawnSync("docker", ["logs", "--timestamps", server], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });

        if (result.error) throw result.error;

        if (result.status !== 0) throw new Error(result.stderr);

        return `${result.stdout}${result.stderr}`;
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

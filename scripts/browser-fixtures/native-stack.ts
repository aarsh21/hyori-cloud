import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorBundle } from "./editor-bundle.ts";
import type { RustStack } from "./rust-stack.ts";

/** Where this stack finds the processes Docker would otherwise supply. */
export type NativeTools = {
  /** A `hyori-server` binary built from this checkout. */
  readonly server: string;
  /** The pinned RustFS release binary. */
  readonly rustfs: string;
  /** PostgreSQL 17's `bin` directory, for `initdb`, `postgres` and `psql`. */
  readonly postgresBin: string;
  /** Every process's output is appended here, because it outlives the stack's own directory. */
  readonly logFile: string;
};

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

function stopped(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * The same stack as `startRustStack`, for hosts that can't run containers: PostgreSQL, RustFS and
 * the server as plain loopback processes over a disposable directory, with random credentials.
 * There is no isolated media worker, because it refuses to run outside its container sandbox.
 */
export async function startNativeRustStack(
  tools: NativeTools,
  origin: string,
  backendPort: number,
  postgresPort: number,
  storagePort: number,
  editorBundle: EditorBundle | null = null,
): Promise<RustStack> {
  const work = mkdtempSync(join(tmpdir(), "hyori-native-stack-"));

  const secrets = {
    POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
    HYORI_SETUP_TOKEN: randomBytes(32).toString("hex"),
    HYORI_AUTH_SECRET: randomBytes(32).toString("hex"),
    RUSTFS_ACCESS_KEY: randomBytes(24).toString("hex"),
    RUSTFS_SECRET_KEY: randomBytes(32).toString("hex"),
  };

  // Fixed for the stack's life: a restarted server must find what it already stored.
  const bucket = `hyori-browser-${randomBytes(4).toString("hex")}`;
  const children: ChildProcess[] = [];
  const logs: string[] = [];

  let server: ChildProcess | null = null;

  function spawnLogged(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
    const child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });

    const keep = (chunk: Buffer) => {
      logs.push(chunk.toString());
      appendFileSync(tools.logFile, chunk);

      if (logs.length > 400) logs.splice(0, logs.length - 400);
    };

    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    children.push(child);

    return child;
  }

  const psql = (statement: string) =>
    execFileSync(
      join(tools.postgresBin, "psql"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(postgresPort),
        "-U",
        "hyori_browser",
        "-d",
        "hyori_browser",
      ].concat(["-v", "ON_ERROR_STOP=1", "-Atc", statement]),
      {
        encoding: "utf8",
        env: { ...process.env, PGPASSWORD: secrets.POSTGRES_PASSWORD },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

  // Synchronous, like every other cleanup step: nothing here holds data worth a graceful exit.
  function stop() {
    for (const child of children.splice(0).reverse()) child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }

  function startServer() {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      APP_ENV: "production",
      APP_ORIGIN: origin,
      HYORI_SERVER_BIND: `127.0.0.1:${backendPort}`,
      HYORI_DATABASE_URL: `postgres://hyori_browser:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/hyori_browser`,
      HYORI_SETUP_TOKEN: secrets.HYORI_SETUP_TOKEN,
      HYORI_AUTH_SECRET: secrets.HYORI_AUTH_SECRET,
      HYORI_STORAGE_ENDPOINT: `http://127.0.0.1:${storagePort}`,
      HYORI_STORAGE_REGION: "us-east-1",
      HYORI_STORAGE_BUCKET: bucket,
      HYORI_STORAGE_ACCESS_KEY: secrets.RUSTFS_ACCESS_KEY,
      HYORI_STORAGE_SECRET_KEY: secrets.RUSTFS_SECRET_KEY,
    };

    if (editorBundle !== null) {
      env.HYORI_EDITOR_ASSETS_DIR = editorBundle.directory;
      env.HYORI_EDITOR_ASSETS_MANIFEST_SHA256 = editorBundle.manifestSha256;
    }

    server = spawnLogged(tools.server, [], env);
  }

  const backendUrl = `http://127.0.0.1:${backendPort}`;

  const ready = () =>
    until(
      async () => {
        if (server?.exitCode !== null) throw new Error("The Rust server exited.");

        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      },
      `The Rust server never reached database-backed readiness.\n${logs.slice(-40).join("")}`,
      60_000,
    );

  try {
    const data = join(work, "postgres");
    const passwordFile = join(work, "pgpass");

    writeFileSync(passwordFile, secrets.POSTGRES_PASSWORD);
    execFileSync(
      join(tools.postgresBin, "initdb"),
      ["-D", data, "-U", "hyori_browser", "--auth=scram-sha-256", `--pwfile=${passwordFile}`],
      { stdio: "ignore" },
    );
    spawnLogged(
      join(tools.postgresBin, "postgres"),
      ["-D", data, "-p", String(postgresPort), "-c", "listen_addresses=127.0.0.1"].concat([
        "-c",
        `unix_socket_directories=${work}`,
        "-c",
        "fsync=off",
      ]),
      { PATH: process.env.PATH },
    );
    await until(
      () => {
        execFileSync(
          join(tools.postgresBin, "psql"),
          [
            "-h",
            "127.0.0.1",
            "-p",
            String(postgresPort),
            "-U",
            "hyori_browser",
            "-d",
            "postgres",
          ].concat(["-Atc", "CREATE DATABASE hyori_browser"]),
          { env: { ...process.env, PGPASSWORD: secrets.POSTGRES_PASSWORD }, stdio: "ignore" },
        );

        return true;
      },
      "PostgreSQL did not become ready.",
      45_000,
    );

    // RustFS refuses a volume path that doesn't exist yet.
    mkdirSync(join(work, "rustfs"));
    spawnLogged(tools.rustfs, [join(work, "rustfs")], {
      PATH: process.env.PATH,
      RUSTFS_ADDRESS: `127.0.0.1:${storagePort}`,
      RUSTFS_ACCESS_KEY: secrets.RUSTFS_ACCESS_KEY,
      RUSTFS_SECRET_KEY: secrets.RUSTFS_SECRET_KEY,
      RUSTFS_CONSOLE_ENABLE: "false",
      RUSTFS_OBS_LOG_DIRECTORY: join(work, "rustfs-logs"),
    });
    await until(
      async () =>
        (
          await fetch(`http://127.0.0.1:${storagePort}/health`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok,
      "RustFS did not become ready.",
      60_000,
    );

    startServer();
    await ready();
  } catch (error) {
    stop();
    throw error;
  }

  const noWorker = () => {
    throw new Error("The native stack has no isolated media worker.");
  };

  return {
    setupToken: secrets.HYORI_SETUP_TOKEN,
    backendUrl,
    webBackend: { network: "host", url: backendUrl },
    async restartServer(whileStopped) {
      if (server !== null) await stopped(server, 10_000);

      try {
        await whileStopped?.();
      } finally {
        startServer();
        await ready();
      }
    },
    stopWorker: noWorker,
    startWorker: async () => noWorker(),
    sql: psql,
    serverLogs: () => readFileSync(tools.logFile, "utf8"),
    stop,
  };
}

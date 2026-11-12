import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { editorContentSecurityPolicy } from "./editor-csp.ts";

/**
 * A persistent development instance for orbs, declared in `.amp/services.yaml`: PostgreSQL 17,
 * RustFS, the Rust server, the built web host and a same-origin gateway that serves the editor
 * bundle the way docs/editor-deployment.md asks Caddy to. Each service runs one role:
 *
 *   bun scripts/dev-stack.ts db|storage|server|web|gateway
 *
 * State and generated credentials live in HYORI_DEV_HOME (default ~/hyori-dev), never in the repo.
 * Without native PostgreSQL or RustFS binaries, db and storage run the deployment's pinned images
 * in Docker instead, keeping their data in the `hyori-dev-pg` and `hyori-dev-rustfs` volumes.
 * Not a deployment recipe: TLS terminates at Amp's portal, and there is no isolated media worker.
 */
const PORTS = { db: 25432, storage: 29000, server: 23003, web: 23001 } as const;
const ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HYORI_DEV_HOME ?? join(homedir(), "hyori-dev");
const POSTGRES_BIN = process.env.HYORI_POSTGRES_BIN ?? "/usr/lib/postgresql/17/bin";
const RUSTFS = process.env.HYORI_RUSTFS_BIN ?? join(homedir(), "opt/rustfs/rustfs");

// Bun 1.3 forwards a request body that arrives in pieces chunked, without its Content-Length,
// and the server rejects such upload parts. A stale system Bun ahead on PATH fails silently.
const PINNED_BUN = z
  .object({ packageManager: z.string().regex(/^bun@/) })
  .parse(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")))
  .packageManager.slice("bun@".length);

if (Bun.semver.order(Bun.version, PINNED_BUN) < 0) {
  throw new Error(`Bun ${Bun.version} at ${process.execPath} is older than the pinned ${PINNED_BUN}.`);
}

const EDITOR_RECEIPT =
  process.env.HYORI_DEV_EDITOR_RECEIPT ?? "tooling/artcraft/runtime-all4-native-v3-r2.json";

const Secrets = z.object({
  pg: z.string(),
  setup: z.string(),
  auth: z.string(),
  s3Key: z.string(),
  s3Secret: z.string(),
});

type Secrets = z.infer<typeof Secrets>;

function secrets(): Secrets {
  const path = join(HOME, "secrets.json");

  if (!existsSync(path)) {
    mkdirSync(HOME, { recursive: true });

    const generated: Secrets = {
      pg: randomBytes(32).toString("hex"),
      setup: randomBytes(16).toString("hex"),
      auth: randomBytes(32).toString("hex"),
      s3Key: randomBytes(24).toString("hex"),
      s3Secret: randomBytes(32).toString("hex"),
    };

    writeFileSync(path, JSON.stringify(generated), { mode: 0o600 });
  }

  return Secrets.parse(JSON.parse(readFileSync(path, "utf8")));
}

function origin() {
  const value = process.env.APP_ORIGIN;

  if (value === undefined) throw new Error("APP_ORIGIN must be the gateway's public URL.");

  return new URL(value).origin;
}

/** Runs the child as this service, so the supervisor's stop reaches it. */
function become(child: ChildProcess) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(command, [...args], { env, stdio: "inherit" });

  become(child);

  return child;
}

/** Secrets reach the container through the CLI's environment, never its argument list. */
function container(name: string, args: readonly string[], secretEnv: Record<string, string>) {
  // A container left behind by an unclean stop would still hold the name and the port.
  spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  run("docker", ["run", "--rm", "--name", name].concat(args), { ...process.env, ...secretEnv });
}

async function db() {
  const { pg } = secrets();

  if (!existsSync(join(POSTGRES_BIN, "postgres"))) {
    container(
      "hyori-dev-pg",
      ["-p", `127.0.0.1:${PORTS.db}:5432`, "-e", "POSTGRES_USER=hyori", "-e", "POSTGRES_DB=hyori"]
        .concat(["-e", "POSTGRES_PASSWORD", "-v", "hyori-dev-pg:/var/lib/postgresql/data"])
        .concat("postgres:17"),
      { POSTGRES_PASSWORD: pg },
    );

    return;
  }

  const data = join(HOME, "pgdata");

  if (!existsSync(data)) {
    const passwordFile = join(HOME, ".pgpass-init");

    writeFileSync(passwordFile, pg, { mode: 0o600 });
    execFileSync(
      join(POSTGRES_BIN, "initdb"),
      ["-D", data, "-U", "hyori", "--auth=scram-sha-256", `--pwfile=${passwordFile}`],
      { stdio: "inherit" },
    );
    rmSync(passwordFile);
  }

  run(
    join(POSTGRES_BIN, "postgres"),
    ["-D", data, "-p", String(PORTS.db), "-c", "listen_addresses=127.0.0.1"].concat([
      "-c",
      `unix_socket_directories=${HOME}`,
    ]),
    { PATH: process.env.PATH },
  );

  const psql = (statement: string) =>
    execFileSync(
      join(POSTGRES_BIN, "psql"),
      ["-h", "127.0.0.1", "-p", String(PORTS.db), "-U", "hyori", "-d", "postgres", "-Atc"].concat(
        statement,
      ),
      { encoding: "utf8", env: { ...process.env, PGPASSWORD: pg } },
    ).trim();

  for (let attempt = 0; ; attempt += 1) {
    try {
      if (psql("SELECT count(*) FROM pg_database WHERE datname='hyori'") === "0") {
        psql("CREATE DATABASE hyori");
      }

      return;
    } catch (error) {
      if (attempt > 100) throw error;

      await Bun.sleep(200);
    }
  }
}

function storage() {
  const { s3Key, s3Secret } = secrets();

  if (!existsSync(RUSTFS)) {
    container(
      "hyori-dev-rustfs",
      ["-p", `127.0.0.1:${PORTS.storage}:9000`, "-e", "RUSTFS_ADDRESS=:9000"]
        .concat(["-e", "RUSTFS_CONSOLE_ENABLE=false", "-e", "RUSTFS_ACCESS_KEY"])
        .concat(["-e", "RUSTFS_SECRET_KEY", "-v", "hyori-dev-rustfs:/data"])
        .concat(["rustfs/rustfs:1.0.0-alpha.85", "/data"]),
      { RUSTFS_ACCESS_KEY: s3Key, RUSTFS_SECRET_KEY: s3Secret },
    );

    return;
  }

  mkdirSync(join(HOME, "rustfs-data"), { recursive: true });
  run(RUSTFS, [join(HOME, "rustfs-data")], {
    PATH: process.env.PATH,
    RUSTFS_ADDRESS: `127.0.0.1:${PORTS.storage}`,
    RUSTFS_ACCESS_KEY: s3Key,
    RUSTFS_SECRET_KEY: s3Secret,
    RUSTFS_CONSOLE_ENABLE: "false",
    RUSTFS_OBS_LOG_DIRECTORY: join(HOME, "rustfs-logs"),
  });
}

/** The pinned editor bundle named by a committed receipt, when it has been built on this host. */
function editorBundle() {
  const receipt = z
    .looseObject({ bundleRoot: z.string(), manifestSha256: z.string() })
    .parse(JSON.parse(readFileSync(join(ROOT, EDITOR_RECEIPT), "utf8")));

  const directory = join(ROOT, receipt.bundleRoot);

  return existsSync(directory) ? { directory, manifestSha256: receipt.manifestSha256 } : null;
}

function server() {
  const { pg, setup, auth, s3Key, s3Secret } = secrets();
  const icu = execFileSync("pkg-config", ["--modversion", "icu-uc"], { encoding: "utf8" }).trim();

  execFileSync("cargo", ["build", "--release", "--locked", "--bin", "hyori-server"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, RUST_ICU_MAJOR_VERSION_NUMBER: icu.split(".")[0] },
  });

  const bundle = editorBundle();

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    APP_ENV: "production",
    APP_ORIGIN: origin(),
    HYORI_SERVER_BIND: `127.0.0.1:${PORTS.server}`,
    HYORI_DATABASE_URL: `postgres://hyori:${pg}@127.0.0.1:${PORTS.db}/hyori`,
    HYORI_SETUP_TOKEN: setup,
    HYORI_AUTH_SECRET: auth,
    HYORI_STORAGE_ENDPOINT: `http://127.0.0.1:${PORTS.storage}`,
    HYORI_STORAGE_REGION: "us-east-1",
    HYORI_STORAGE_BUCKET: "hyori",
    HYORI_STORAGE_ACCESS_KEY: s3Key,
    HYORI_STORAGE_SECRET_KEY: s3Secret,
  };

  if (bundle !== null) {
    env.HYORI_EDITOR_ASSETS_DIR = bundle.directory;
    env.HYORI_EDITOR_ASSETS_MANIFEST_SHA256 = bundle.manifestSha256;
  }

  console.log(`Setup token: ${setup}`);
  run(join(ROOT, "target/release/hyori-server"), [], env);
}

/** The web host laid out as apps/web/Dockerfile does, so it runs with only its own environment. */
function web() {
  const output = join(ROOT, "apps/web/.output");

  if (!existsSync(output)) {
    execFileSync("bun", ["run", "--cwd", "apps/web", "build"], { cwd: ROOT, stdio: "inherit" });
  }

  const directory = join(HOME, "web");

  rmSync(directory, { recursive: true, force: true });
  cpSync(output, join(directory, "output"), { recursive: true });
  cpSync(join(ROOT, "apps/web/.env.schema"), join(directory, ".env.schema"));
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });

  for (const [from, to] of [
    ["node_modules/varlock", "node_modules/varlock"],
    ["apps/web/node_modules/react", "node_modules/react"],
  ] as const) {
    cpSync(join(ROOT, from), join(directory, to), { recursive: true, dereference: true });
  }

  symlinkSync("../varlock/bin/cli.js", join(directory, "node_modules/.bin/varlock"));

  const child = spawn("node", ["output/server/index.mjs"], {
    cwd: directory,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      APP_ENV: "production",
      APP_ORIGIN: origin(),
      HYORI_BACKEND_URL: `http://127.0.0.1:${PORTS.server}`,
      HOST: "127.0.0.1",
      PORT: String(PORTS.web),
    },
  });

  become(child);
}

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".wasm", "application/wasm"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer"];

function editorAsset(
  bundle: { directory: string; contentSecurityPolicy: string } | null,
  pathname: string,
  accepts: string,
) {
  if (bundle === null) return new Response("Not found", { status: 404 });

  const root = bundle.directory;

  const path = resolve(root, `.${decodeURIComponent(pathname.slice("/artcraft".length))}`);
  const file = path.startsWith(`${root}${sep}`) ? lstatSync(path, { throwIfNoEntry: false }) : null;

  if (file === undefined || file === null || !file.isFile()) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-cache" } });
  }

  const headers = new Headers({
    "content-type": TYPES.get(extname(path)) ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "content-security-policy": bundle.contentSecurityPolicy,
    "cache-control": /\/[^/]+-[0-9a-f]{15,20}(_bg)?\.(wasm|js|css)$/.test(path)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    vary: "accept-encoding",
  });

  // A verified sidecar, byte for byte, like Caddy's `precompressed gzip`.
  if (/\bgzip\b/.test(accepts) && existsSync(`${path}.gz`)) {
    headers.set("content-encoding", "gzip");

    return new Response(Bun.file(`${path}.gz`), { headers });
  }

  return new Response(Bun.file(path), { headers });
}

function gateway() {
  const publicUrl = new URL(process.env.PUBLIC_URL ?? "");
  const configured = editorBundle();

  // Derived once from the bundle this gateway serves, as the production Caddy line is.
  const bundle =
    configured === null
      ? null
      : {
          ...configured,
          contentSecurityPolicy: editorContentSecurityPolicy(
            configured.directory,
            join(ROOT, EDITOR_RECEIPT),
          ),
        };

  Bun.serve({
    port: Number(process.env.PORT),
    hostname: "127.0.0.1",
    idleTimeout: 255,
    maxRequestBodySize: 128 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") return new Response("ok");

      if (url.pathname.startsWith("/artcraft/")) {
        return editorAsset(bundle, url.pathname, request.headers.get("accept-encoding") ?? "");
      }

      const headers = new Headers(request.headers);

      // Copied first: deleting while iterating Headers skips entries.
      for (const name of Array.from(headers.keys())) {
        if (HOP.includes(name) || name === "forwarded" || name.startsWith("x-forwarded-")) {
          headers.delete(name);
        }
      }

      // The web host checks the public authority itself, so the private hop carries exactly that.
      headers.set("host", publicUrl.host);

      try {
        const response = await fetch(`http://127.0.0.1:${PORTS.web}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          decompress: false,
          signal: request.signal,
        });

        const out = new Headers(response.headers);

        for (const name of HOP) out.delete(name);

        return new Response(response.body, { status: response.status, headers: out });
      } catch (error) {
        console.error(`${request.method} ${url.pathname}:`, error);

        return new Response("Hyori is starting. Reload in a moment.", { status: 503 });
      }
    },
  });

  const editors = bundle === null ? "no editor bundle" : `editors ${bundle.manifestSha256}`;

  console.log(`Gateway for ${publicUrl.origin}, ${editors}`);
}

switch (process.argv[2]) {
  case "db":
    await db();
    break;
  case "storage":
    storage();
    break;
  case "server":
    server();
    break;
  case "web":
    web();
    break;
  case "gateway":
    gateway();
    break;
  default:
    throw new Error("Pass one of: db, storage, server, web, gateway");
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@hyori-cloud/client-sdk";
import { availablePort } from "./available-port.ts";

const image = process.argv[2];

if (!image) throw new Error("Pass an already built Rust image; build apps/web first.");

const suffix = randomBytes(8).toString("hex");
const network = `hyori-host-network-${suffix}`;
const postgres = `hyori-host-postgres-${suffix}`;
const storage = `hyori-host-storage-${suffix}`;
const backend = `hyori-host-backend-${suffix}`;
const created: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const gateways: ReturnType<typeof Bun.serve>[] = [];
const clients: ReturnType<typeof createClient>[] = [];
const directory = mkdtempSync(join(tmpdir(), "hyori-nitro-host-"));
const password = randomBytes(32).toString("hex");
const setupToken = randomBytes(32).toString("hex");

const secrets = {
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  HYORI_AUTH_SECRET: randomBytes(32).toString("hex"),
  HYORI_STORAGE_ACCESS_KEY: randomBytes(24).toString("hex"),
  HYORI_STORAGE_SECRET_KEY: randomBytes(32).toString("hex"),
};

function docker(args: string[], extra: NodeJS.ProcessEnv = {}) {
  return execFileSync("docker", args, {
    env: { PATH: process.env.PATH, ...secrets, ...extra },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90_000,
  }).trim();
}

async function ready(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Disposable PostgreSQL, RustFS and the production host initialize independently.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${label} never became ready`);
}

function published(name: string, port: number) {
  const address = docker(["port", name, `${port}/tcp`]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);

  return `http://${address}`;
}

async function startWeb(origin: string, backendUrl: string, production = true) {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn("node", [join(directory, "output/server/index.mjs")], {
    cwd: directory,
    // No inherited setup/database/storage credentials or actual .env files on the web host.
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      APP_ENV: production ? "production" : "test",
      APP_ORIGIN: origin,
      HYORI_BACKEND_URL: backendUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  children.push(child);
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-4000);
  });

  try {
    await ready(async () => {
      if (child.exitCode !== null) throw new Error(`Nitro exited: ${diagnostic}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();

      return response.ok;
    }, "Built Nitro web host");
  } catch (error) {
    throw new Error(`Built Nitro readiness failed.\n${diagnostic}`, { cause: error });
  }

  return url;
}

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

try {
  cpSync(join(process.cwd(), "apps/web/.output"), join(directory, "output"), { recursive: true });
  cpSync(join(process.cwd(), "apps/web/.env.schema"), join(directory, ".env.schema"));
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  cpSync(join(process.cwd(), "node_modules/varlock"), join(directory, "node_modules/varlock"), {
    recursive: true,
    dereference: true,
  });
  cpSync(
    join(process.cwd(), "apps/web/node_modules/react"),
    join(directory, "node_modules/react"),
    {
      recursive: true,
      dereference: true,
    },
  );
  symlinkSync("../varlock/bin/cli.js", join(directory, "node_modules/.bin/varlock"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore", timeout: 30_000 },
  );
  const cert = readFileSync(certPath, "utf8");
  const key = readFileSync(keyPath, "utf8");
  let hostUrl = "";

  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key, cert },
    fetch: (request) => {
      const incoming = new URL(request.url);
      const target = new URL(`${incoming.pathname}${incoming.search}`, hostUrl);

      // A real HTTPS terminator preserves the public Host on its private HTTP hop, and passes a
      // compressed body through as the host encoded it.
      return fetch(new Request(target, request), { redirect: "manual", decompress: false });
    },
  });

  gateways.push(gateway);
  const origin = gateway.url.origin;
  const authority = new URL(origin).host;

  docker(["network", "create", network]);
  docker([
    "run",
    "--detach",
    "--name",
    postgres,
    "--network",
    network,
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    "POSTGRES_USER=hyori_host",
    "-e",
    "POSTGRES_DB=hyori_host",
    "postgres:17",
  ]);
  created.push(postgres);
  await ready(async () => {
    docker(["exec", postgres, "pg_isready", "-U", "hyori_host", "-d", "hyori_host"]);

    return true;
  }, "PostgreSQL");
  docker(
    [
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
    ],
    {
      RUSTFS_ACCESS_KEY: secrets.HYORI_STORAGE_ACCESS_KEY,
      RUSTFS_SECRET_KEY: secrets.HYORI_STORAGE_SECRET_KEY,
    },
  );
  created.push(storage);
  const storageUrl = published(storage, 9000);
  await ready(
    async () => (await fetch(`${storageUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok,
    "RustFS",
  );
  docker(
    [
      "run",
      "--detach",
      "--name",
      backend,
      "--network",
      network,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "-p",
      "127.0.0.1::3002",
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
      `HYORI_STORAGE_BUCKET=hyori-host-${suffix}`,
      "-e",
      "HYORI_STORAGE_ACCESS_KEY",
      "-e",
      "HYORI_STORAGE_SECRET_KEY",
      image,
    ],
    {
      HYORI_DATABASE_URL: `postgres://hyori_host:${secrets.POSTGRES_PASSWORD}@${postgres}:5432/hyori_host`,
      HYORI_SETUP_TOKEN: setupToken,
    },
  );
  created.push(backend);
  const backendUrl = published(backend, 3002);
  await ready(
    async () =>
      (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok,
    "Rust release image",
  );
  hostUrl = await startWeb(origin, backendUrl);
  await assert.rejects(fetch(origin), /certificate|self.signed|unable.to.verify/i);
  const page = await fetch(origin, { tls: { ca: cert } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(html.includes(backendUrl), false);
  assert.equal(html.includes("HYORI_BACKEND_URL"), false);

  const inspectPublicAssets = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);

      if (entry.isDirectory()) inspectPublicAssets(file);
      else if (/\.(?:js|html|json)$/.test(entry.name)) {
        const content = readFileSync(file, "utf8");
        assert.equal(
          content.includes(backendUrl),
          false,
          `Private origin leaked into ${entry.name}`,
        );
        assert.equal(
          content.includes("HYORI_BACKEND_URL"),
          false,
          `Private env key leaked into ${entry.name}`,
        );
      }
    }
  };

  inspectPublicAssets(join(directory, "output/public"));

  const cookies = new Map<string, string>();

  const send = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set("origin", origin);

    if (cookies.size) request.headers.set("cookie", [...cookies.values()].join("; "));
    const response = await fetch(request, { tls: { ca: cert } });

    for (const cookie of response.headers.getSetCookie()) {
      assert.match(cookie, /;\s*Secure(?:;|$)/i);
      assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
      const pair = cookie.split(";", 1)[0]!;
      const name = pair.slice(0, pair.indexOf("="));

      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, pair);
    }

    return response;
  };

  const sdk = createClient({ baseUrl: `${origin}/api/rpc`, fetch: send });
  clients.push(sdk);
  assert.deepEqual(await sdk.rpc.auth.status({}), { initialized: false, user: null });
  await sdk.rpc.auth.setup({
    setupToken,
    email: "host@example.test",
    password,
    name: "Nitro host fixture",
  });
  const folder = await sdk.rpc.files.createFolder({ parentId: null, name: "Pictures" });
  const bytes = new Uint8Array(8 * 1024 * 1024 + 31).fill(83);

  const file = await sdk.uploads.start({
    parentId: folder.id,
    file: new File([bytes], "nitro.bin"),
  }).result;

  const download = await sdk.downloads.open({ id: file.id });
  assert.equal(
    hash(new Uint8Array(await new Response(download.stream).arrayBuffer())),
    hash(bytes),
  );
  const descriptor = await sdk.rpc.files.download({ id: file.id });
  const range = await send(new URL(descriptor.url, origin), { headers: { Range: "bytes=2-4" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 2-4/${bytes.byteLength}`);
  assert.equal(range.headers.get("content-length"), "3");
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(2, 5));

  const invalidRange = await send(new URL(descriptor.url, origin), {
    headers: { Range: "bytes=999999999-" },
  });

  assert.equal(invalidRange.status, 416);
  await invalidRange.body?.cancel();

  const png = readFileSync(join(process.cwd(), "apps/server/tests/fixtures/media/red.png"));

  const media = await sdk.uploads.start({
    parentId: folder.id,
    file: new File([png], "red.png", { type: "image/png" }),
  }).result;

  await sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [folder.id] });
  assert.equal((await sdk.rpc.photos.timeline({})).items[0]?.id, media.id);
  const preview = await sdk.rpc.files.preview({ id: media.id });
  const original = await send(new URL(preview.url, origin));
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.equal(hash(new Uint8Array(await original.arrayBuffer())), hash(png));
  const users = await sdk.rpc.admin.users({});
  assert.equal(users.items[0]?.email, "host@example.test");

  const second = await sdk.rpc.admin.createUser({
    email: "second@example.test",
    password,
    name: "Second",
    quotaBytes: 1024,
  });

  await sdk.rpc.admin.setQuota({ userId: second.id, quotaBytes: 2048 });
  assert.equal(
    (await sdk.rpc.admin.users({})).items.find((user) => user.id === second.id)?.quotaBytes,
    2048,
  );

  const attack = async (headers: HeadersInit) => {
    const response = await fetch(`${hostUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      body: JSON.stringify({ operation: "auth.status", input: {} }),
    });

    await response.body?.cancel();

    return response.status;
  };

  assert.equal(
    await attack({
      Host: "attacker.test",
      Origin: origin,
      "X-Forwarded-Host": authority,
      "X-Forwarded-Proto": "https",
    }),
    403,
  );
  assert.equal(await attack({ Host: authority, Origin: "https://attacker.test" }), 403);
  assert.equal(await attack({ Host: authority, Cookie: [...cookies.values()].join("; ") }), 403);
  assert.equal(
    await attack({ Host: authority, Origin: origin, "Sec-Fetch-Site": "cross-site" }),
    403,
  );
  assert.equal(
    await attack({
      Host: authority,
      Origin: origin,
      Forwarded: "host=attacker.test;proto=http",
      "X-Forwarded-Host": "attacker.test",
    }),
    200,
  );

  for (const [configuredOrigin, configuredBackend] of [
    [origin, ""],
    [origin, "http://127.0.0.1:9"],
    [origin, "http://user:password@private.test"],
    [origin.replace("https:", "http:"), backendUrl],
    ["not-an-origin", backendUrl],
    [origin, "not-an-origin"],
    [origin, "http://private.test/prefix"],
  ] as const) {
    const invalidHost = await startWeb(configuredOrigin, configuredBackend);

    const response = await fetch(`${invalidHost}/api/rpc`, {
      method: "POST",
      headers: { Host: authority, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "auth.status", input: {} }),
    });

    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.doesNotMatch(await response.text(), /password|postgres:|HYORI_AUTH_SECRET/);
  }

  await sdk.rpc.auth.logout({});
  assert.equal((await sdk.rpc.auth.status({})).user, null);
  console.log(
    "PASS actual built Nitro host → immutable Rust image → real PostgreSQL/RustFS: TLS-verified disposable HTTPS termination, public Host mapping, secure cookies, setup/auth/folder/multipart upload/SHA-256 download, 206 exact length and 416, Photos/safe original, admin quota, CSRF/authority/forwarding attacks, logout, missing/invalid/unavailable config. HTML/client assets exclude the private backend URL/key. No web secrets, legacy router or browser bypass. Not browser, derivative, editor, capacity or deployment acceptance.",
  );
} finally {
  for (const client of clients) client.dispose();

  for (const gateway of gateways) gateway.stop(true);

  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }),
  );

  for (const name of created.reverse()) docker(["rm", "--force", "--volumes", name]);

  try {
    docker(["network", "rm", network]);
  } catch {
    // A failure before network creation has no shared or existing resources to remove.
  }

  rmSync(directory, { recursive: true, force: true });
}

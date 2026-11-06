import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient, decodeUploadCheckpoint } from "@hyori-cloud/client-sdk";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const suffix = randomBytes(8).toString("hex");
const postgresName = `hyori-upload-sdk-pg-${suffix}`;
const storageName = `hyori-upload-sdk-fs-${suffix}`;
const password = randomBytes(32).toString("hex");
const setupToken = randomBytes(32).toString("hex");
const authSecret = randomBytes(32).toString("hex");
const storageAccess = randomBytes(24).toString("hex");
const storageSecret = randomBytes(32).toString("hex");
const clients: ReturnType<typeof createClient>[] = [];
let backend: ReturnType<typeof Bun.spawn> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;

function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      POSTGRES_PASSWORD: password,
      RUSTFS_ACCESS_KEY: storageAccess,
      RUSTFS_SECRET_KEY: storageSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureSql(statement: string) {
  return docker([
    "exec",
    postgresName,
    "psql",
    "-U",
    "hyori_sdk",
    "-d",
    "hyori_sdk",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    statement,
  ]);
}

async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

function client(origin: string) {
  const cookies = new Map<string, string>();
  const fault = { failNextPart: false, loseNextCompletion: false, partWrites: 0 };

  const sdk = createClient({
    baseUrl: `${origin}/api/rpc`,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);

      if (cookies.size) headers.set("Cookie", [...cookies.values()].join("; "));

      if (init?.method === "PUT") {
        fault.partWrites++;

        if (fault.failNextPart) {
          fault.failNextPart = false;

          return new Response(null, { status: 503 });
        }
      }

      const response = await fetch(input, { ...init, headers });

      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0]!;
        const separator = pair.indexOf("=");
        assert.ok(separator > 0);
        const name = pair.slice(0, separator);

        if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, pair);
      }

      if (fault.loseNextCompletion && String(init?.body).includes('"uploads.complete"')) {
        fault.loseNextCompletion = false;
        assert.ok(response.ok, "the real server must commit before its response is lost");
        await response.arrayBuffer();
        throw new Error("Fixture dropped the committed completion response");
      }

      return response;
    },
  });

  clients.push(sdk);

  return { sdk, fault };
}

async function hashDownload(sdk: ReturnType<typeof createClient>, id: string) {
  const opened = await sdk.downloads.open({ id });
  const reader = opened.stream.getReader();
  const hash = createHash("sha256");
  let bytes = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      hash.update(chunk.value);
      bytes += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  assert.equal(bytes, opened.metadata.size);

  return hash.digest("hex");
}

try {
  execFileSync(build.executable, ["build", "--locked", "--bin", "hyori-server"], {
    env: build.env,
    stdio: "inherit",
  });
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    postgresName,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_PASSWORD",
    "-e",
    "POSTGRES_USER=hyori_sdk",
    "-e",
    "POSTGRES_DB=hyori_sdk",
    "postgres:17",
  ]);
  const postgresAddress = docker(["port", postgresName, "5432/tcp"]);
  assert.match(postgresAddress, /^127\.0\.0\.1:\d+$/);
  await waitFor(async () => {
    try {
      docker([
        "exec",
        postgresName,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "hyori_sdk",
        "-d",
        "hyori_sdk",
      ]);

      return true;
    } catch {
      return false;
    }
  }, "PostgreSQL fixture did not become ready");
  docker([
    "run",
    "--detach",
    "--name",
    storageName,
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
  const storageAddress = docker(["port", storageName, "9000/tcp"]);
  assert.match(storageAddress, /^127\.0\.0\.1:\d+$/);
  const storageEndpoint = `http://${storageAddress}`;
  await waitFor(async () => {
    try {
      return (await fetch(`${storageEndpoint}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }, "RustFS fixture did not become ready");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const backendUrl = reservation.url.origin;
  const bind = reservation.url.host;
  reservation.stop(true);

  let handle: (request: Request) => Promise<Response> = async () =>
    new Response(null, { status: 503 });

  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handle(request) });
  const origin = proxy.url.origin;
  handle = createBackendProxy({ origin, backendUrl });

  const start = async () => {
    backend = Bun.spawn(["target/debug/hyori-server"], {
      env: {
        ...build.env,
        APP_ENV: "development",
        APP_ORIGIN: origin,
        HYORI_DATABASE_URL: `postgres://hyori_sdk:${password}@${postgresAddress}/hyori_sdk`,
        HYORI_SETUP_TOKEN: setupToken,
        HYORI_AUTH_SECRET: authSecret,
        HYORI_SERVER_BIND: bind,
        HYORI_STORAGE_ENDPOINT: storageEndpoint,
        HYORI_STORAGE_REGION: "us-east-1",
        HYORI_STORAGE_BUCKET: `hyori-sdk-${suffix}`,
        HYORI_STORAGE_ACCESS_KEY: storageAccess,
        HYORI_STORAGE_SECRET_KEY: storageSecret,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitFor(async () => {
      if (backend?.exitCode !== null)
        throw new Error("Rust upload fixture exited before readiness");

      try {
        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    }, "Rust upload fixture did not become ready");
  };

  await start();
  const { sdk, fault } = client(origin);

  const owner = await sdk.rpc.auth.setup({
    setupToken,
    email: "owner@example.test",
    name: "Owner",
    password: randomBytes(24).toString("hex"),
  });

  const content = new Uint8Array(8 * 1024 * 1024 + 67).fill(73);

  const file = new File([content], "restart.bin", {
    type: "application/octet-stream",
    lastModified: 12345,
  });

  const task = sdk.uploads.start({ parentId: null, file });
  task.subscribe(() => {
    const snapshot = task.getSnapshot();

    if (snapshot.status === "uploading" && snapshot.uploadedBytes >= 8 * 1024 * 1024) task.pause();
  });
  await assert.rejects(task.result);
  const checkpoint = task.getSnapshot().checkpoint;
  assert.ok(checkpoint);
  assert.equal(task.getSnapshot().status, "paused");
  assert.equal((await sdk.rpc.uploads.status({ uploadId: checkpoint.uploadId })).parts.length, 1);
  assert.equal(fault.partWrites, 1);
  task.dispose();
  backend!.kill("SIGTERM");
  assert.equal(await backend!.exited, 0);
  await start();
  const savedCheckpoint = decodeUploadCheckpoint(JSON.parse(JSON.stringify(checkpoint)));

  const reselected = new File([content], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });

  const resumed = sdk.uploads.resume({
    checkpoint: savedCheckpoint,
    file: reselected,
    confirmSameFile: true,
  });

  const uploaded = await resumed.result;
  assert.equal(fault.partWrites, 2, "resume uploads only the missing tail");
  assert.equal(
    await hashDownload(sdk, uploaded.id),
    createHash("sha256").update(content).digest("hex"),
  );
  assert.equal((await sdk.rpc.auth.status({})).user?.usedBytes, file.size);
  const empty = await sdk.uploads.start({ parentId: null, file: new File([], "empty.bin") }).result;
  assert.equal(await hashDownload(sdk, empty.id), createHash("sha256").digest("hex"));
  fault.failNextPart = true;

  const retry = sdk.uploads.start(
    { parentId: null, file: new File(["retry"], "retry.bin") },
    { maxRetries: 0 },
  );

  await assert.rejects(retry.result);
  assert.equal(retry.getSnapshot().status, "failed");
  const retried = await retry.retry();
  assert.equal(retried.size, 5);
  fault.loseNextCompletion = true;

  const ambiguous = sdk.uploads.start({
    parentId: null,
    file: new File(["commit"], "ambiguous.bin"),
  });

  await assert.rejects(ambiguous.result);
  const beforeReplay = (await sdk.rpc.auth.status({})).user?.usedBytes;
  backend!.kill("SIGTERM");
  assert.equal(await backend!.exited, 0);
  await start();
  assert.equal((await ambiguous.retry()).size, 6);
  assert.equal((await sdk.rpc.auth.status({})).user?.usedBytes, beforeReplay);
  const cancelled = sdk.uploads.start({ parentId: null, file: new File([content], "cancel.bin") });
  cancelled.subscribe(() => {
    if (cancelled.getSnapshot().checkpoint) cancelled.pause();
  });
  await assert.rejects(cancelled.result);
  await cancelled.cancel();
  assert.equal(cancelled.getSnapshot().status, "cancelled");
  assert.equal(fixtureSql(`SELECT reserved_bytes FROM hyori_users WHERE id='${owner.id}'`), "0");

  const replacement = await sdk.uploads.start({
    parentId: null,
    replaceId: retried.id,
    file: new File(["version"], "retry.bin"),
  }).result;

  assert.equal(replacement.id, retried.id);
  const versions = await sdk.rpc.files.versions({ id: retried.id });
  assert.equal(versions.items.length, 1);
  await sdk.rpc.files.restoreVersion({ id: retried.id, versionId: versions.items[0]!.id });
  assert.equal(
    await hashDownload(sdk, retried.id),
    createHash("sha256").update("retry").digest("hex"),
  );
  assert.equal(
    fixtureSql("SELECT sum(size) FROM hyori_objects"),
    String((await sdk.rpc.auth.status({})).user?.usedBytes),
  );
  console.log(
    "Real Rust -> web proxy -> vanilla SDK: multipart pause/checkpoint/process-restart/resume, streamed byte digest, zero-byte, retry, lost-complete replay, cancellation, replacement/history/restore, and distinct-object quota passed.",
  );
} finally {
  for (const sdk of clients) sdk.dispose();
  proxy?.stop(true);

  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await backend.exited;
  }

  for (const name of [postgresName, storageName]) {
    try {
      docker(["rm", "--force", name]);
    } catch {
      // Only this run's unique resources are addressed, including partial startup failures.
    }
  }
}

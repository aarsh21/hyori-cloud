import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import {
  createClient,
  createUploadQueue,
  decodeUploadCheckpoint,
  type CheckpointStore,
  type UploadCheckpoint,
} from "@hyori-cloud/client-sdk";

const image = process.argv[2];

if (!image) throw new Error("Pass a locally built Rust server image tag.");

const suffix = randomBytes(8).toString("hex");
const network = `hyori-image-network-${suffix}`;
const postgres = `hyori-image-postgres-${suffix}`;
const server = `hyori-image-server-${suffix}`;
const storage = `hyori-image-storage-${suffix}`;
const origin = "https://hyori-image.test";

const env = {
  ...process.env,
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  HYORI_SETUP_TOKEN: randomBytes(32).toString("hex"),
  HYORI_AUTH_SECRET: randomBytes(32).toString("hex"),
  RUSTFS_ACCESS_KEY: randomBytes(24).toString("hex"),
  RUSTFS_SECRET_KEY: randomBytes(32).toString("hex"),
};

const password = randomBytes(24).toString("hex");
const cookies = new Map<string, string>();
let sdk: ReturnType<typeof createClient> | undefined;
let queue: ReturnType<typeof createUploadQueue> | undefined;
let createdNetwork = false;
let createdPostgres = false;
let createdServer = false;
let createdStorage = false;

function docker(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return execFileSync("docker", args, {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(message);
}

async function ready(url: string) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    assert.equal(docker(["inspect", "--format", "{{.State.Running}}", server]), "true");

    try {
      if ((await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // The real release entrypoint may still be connecting and applying migrations.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Release image never reached database-backed readiness.");
}

try {
  assert.equal(docker(["image", "inspect", "--format", "{{.Config.User}}", image]), "10001:10001");
  docker(["network", "create", network]);
  createdNetwork = true;
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
    "POSTGRES_USER=hyori_image",
    "-e",
    "POSTGRES_DB=hyori_image",
    "postgres:17",
  ]);
  createdPostgres = true;
  const postgresDeadline = Date.now() + 30_000;
  let postgresReady = false;

  while (Date.now() < postgresDeadline) {
    try {
      docker([
        "exec",
        postgres,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "hyori_image",
        "-d",
        "hyori_image",
      ]);
      postgresReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.ok(postgresReady, "Isolated PostgreSQL image fixture did not start.");
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
  createdStorage = true;
  const storageAddress = docker(["port", storage, "9000/tcp"]);
  assert.match(storageAddress, /^127\.0\.0\.1:\d+$/);
  const storageDeadline = Date.now() + 60_000;
  let storageReady = false;

  while (Date.now() < storageDeadline) {
    try {
      if (
        (await fetch(`http://${storageAddress}/health`, { signal: AbortSignal.timeout(1000) })).ok
      ) {
        storageReady = true;
        break;
      }
    } catch {
      // Unique tmpfs-backed RustFS may still be initializing.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(storageReady, "Pinned RustFS image fixture did not start.");
  docker(
    [
      "run",
      "--detach",
      "--name",
      server,
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
      `HYORI_STORAGE_BUCKET=hyori-image-${suffix}`,
      "-e",
      "HYORI_STORAGE_ACCESS_KEY",
      "-e",
      "HYORI_STORAGE_SECRET_KEY",
      image,
    ],
    {
      HYORI_DATABASE_URL: `postgres://hyori_image:${env.POSTGRES_PASSWORD}@${postgres}:5432/hyori_image`,
      HYORI_STORAGE_ACCESS_KEY: env.RUSTFS_ACCESS_KEY,
      HYORI_STORAGE_SECRET_KEY: env.RUSTFS_SECRET_KEY,
    },
  );
  createdServer = true;
  const address = docker(["port", server, "3002/tcp"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  let backendUrl = `http://${address}`;
  let proxy = createBackendProxy({ origin, backendUrl });
  await ready(backendUrl);
  assert.equal(docker(["exec", server, "id", "-u"]), "10001");
  sdk = createClient({
    baseUrl: `${origin}/api/rpc`,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);

      // This direct Fetch-host fixture must supply the length that HTTP normally adds for a Blob.
      if (init?.body instanceof Blob) headers.set("Content-Length", String(init.body.size));

      if (cookies.size) headers.set("Cookie", [...cookies.values()].join("; "));
      const response = await proxy(new Request(input, { ...init, headers }));

      for (const cookie of response.headers.getSetCookie()) {
        assert.match(cookie, /; Secure(?:;|$)/);
        assert.match(cookie, /; HttpOnly(?:;|$)/);
        const pair = cookie.split(";", 1)[0]!;
        const separator = pair.indexOf("=");
        assert.ok(separator > 0);
        const name = pair.slice(0, separator);

        if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, pair);
      }

      return response;
    },
  });
  assert.deepEqual(await sdk.rpc.auth.status({}), { initialized: false, user: null });

  const owner = await sdk.rpc.auth.setup({
    setupToken: env.HYORI_SETUP_TOKEN,
    email: "image@example.test",
    name: "Image fixture",
    password,
  });

  const folder = await sdk.rpc.files.createFolder({ parentId: null, name: "Release image" });
  assert.equal((await sdk.rpc.files.list({})).items[0]?.id, folder.id);
  const content = new Uint8Array(8 * 1024 * 1024 + 17).fill(73);

  const uploaded = await sdk.uploads.start({
    parentId: folder.id,
    file: new File([content], "release.bin", { type: "application/octet-stream" }),
  }).result;

  const download = await sdk.downloads.open({ id: uploaded.id });
  const actual = new Uint8Array(await new Response(download.stream).arrayBuffer());
  assert.equal(actual.byteLength, content.byteLength);
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(content).digest("hex"),
  );
  const edited = new Uint8Array(8 * 1024 * 1024 + 17).fill(91);

  const localFile = new File([edited], "locally-edited-copy.bin", {
    type: "application/octet-stream",
    lastModified: 12345,
  });

  let saved: readonly UploadCheckpoint[] = [];

  const store: CheckpointStore = {
    read: () => saved,
    write: (checkpoints) => {
      saved = checkpoints.map((value) => decodeUploadCheckpoint(JSON.parse(JSON.stringify(value))));
    },
  };

  const firstQueue = createUploadQueue(sdk, store);
  queue = firstQueue;
  let paused = false;
  firstQueue.subscribe(() => {
    const entry = firstQueue.getEntries()[0];

    if (
      entry?.state === "started" &&
      !paused &&
      entry.task.getSnapshot().uploadedBytes >= 8 * 1024 * 1024
    ) {
      paused = true;
      firstQueue.pause(entry.id);
    }
  });
  firstQueue.replace({
    file: localFile,
    parentId: folder.id,
    target: { id: uploaded.id, name: uploaded.name },
  });
  await until(
    () =>
      firstQueue
        .getEntries()
        .some((entry) => entry.state === "started" && entry.task.getSnapshot().status === "paused"),
    "Replacement never reached a durable paused checkpoint.",
  );
  assert.equal(saved[0]?.file.name, localFile.name);
  firstQueue.dispose();
  docker(["stop", "--time", "10", server]);
  assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", server]), "0");
  docker(["start", server]);
  const restartedAddress = docker(["port", server, "3002/tcp"]);
  assert.match(restartedAddress, /^127\.0\.0\.1:\d+$/);
  backendUrl = `http://${restartedAddress}`;
  proxy = createBackendProxy({ origin, backendUrl });
  await ready(backendUrl);
  assert.equal((await sdk.rpc.auth.status({})).user?.id, owner.id);
  assert.equal((await sdk.rpc.files.list({})).items[0]?.id, folder.id);
  const persisted = await sdk.downloads.open({ id: uploaded.id });
  assert.equal(
    createHash("sha256")
      .update(new Uint8Array(await new Response(persisted.stream).arrayBuffer()))
      .digest("hex"),
    createHash("sha256").update(content).digest("hex"),
  );
  const resumedQueue = createUploadQueue(sdk, store);
  queue = resumedQueue;
  const interrupted = resumedQueue.getEntries()[0];
  assert.ok(interrupted?.state === "interrupted");
  assert.equal(interrupted.intent.kind, "replacement");
  assert.equal(interrupted.intent.name, uploaded.name);
  resumedQueue.resume(interrupted.id, localFile);
  await until(
    () => resumedQueue.getSummary().complete === 1,
    "Replacement did not resume from its serialized checkpoint.",
  );
  const replaced = await sdk.downloads.open({ id: uploaded.id });
  assert.equal(
    createHash("sha256")
      .update(new Uint8Array(await new Response(replaced.stream).arrayBuffer()))
      .digest("hex"),
    createHash("sha256").update(edited).digest("hex"),
  );
  assert.equal((await sdk.rpc.files.versions({ id: uploaded.id })).items.length, 1);
  resumedQueue.dispose();
  await sdk.rpc.auth.logout({});
  assert.equal((await sdk.rpc.auth.status({})).user, null);
  process.stdout.write(
    "PASS release container: native libraries, UID 10001, read-only root, production cookie policy, migrations, real public SDK setup/folder/multipart upload/SHA-256 download/logout, clean shutdown, restart persistence and differently named replacement checkpoint/reselection/resume against PostgreSQL and pinned RustFS. TLS termination and whole-product workflows are not tested.\n",
  );
} catch (error) {
  if (createdServer) process.stderr.write(`${docker(["logs", server])}\n`);
  throw error;
} finally {
  queue?.dispose();
  sdk?.dispose();

  if (createdServer) docker(["rm", "--force", "--volumes", server]);

  if (createdPostgres) docker(["rm", "--force", "--volumes", postgres]);

  if (createdStorage) docker(["rm", "--force", "--volumes", storage]);

  if (createdNetwork) docker(["network", "rm", network]);
}

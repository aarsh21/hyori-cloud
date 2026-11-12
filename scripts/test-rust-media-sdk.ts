import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient } from "@hyori-cloud/client-sdk";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const suffix = randomBytes(8).toString("hex");
const postgresName = `hyori-media-sdk-pg-${suffix}`;
const storageName = `hyori-media-sdk-fs-${suffix}`;
const workerName = `hyori-media-sdk-worker-${suffix}`;
const ownedImage = process.env.HYORI_MEDIA_TEST_IMAGE === undefined;
const workerImage = process.env.HYORI_MEDIA_TEST_IMAGE ?? `hyori-media-sdk:${suffix}`;
const directory = await mkdtemp(join(tmpdir(), "hyori-media-sdk-"));
const socketPath = join(directory, "worker.sock");
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

async function waitFor(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(message);
}

function socketReady() {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ path: socketPath });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function client(origin: string) {
  const cookies = new Map<string, string>();

  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);

    if (cookies.size) headers.set("Cookie", [...cookies.values()].join("; "));

    const response = await fetch(input, { ...init, headers });

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      assert.ok(separator > 0);
      const name = pair.slice(0, separator);

      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, pair);
    }

    return response;
  };

  const sdk = createClient({ baseUrl: `${origin}/api/rpc`, fetch: authenticatedFetch });
  clients.push(sdk);

  return { sdk, get: (url: string) => authenticatedFetch(new URL(url, origin)) };
}

try {
  execFileSync(build.executable, ["build", "--locked", "--bin", "hyori-server"], {
    env: build.env,
    stdio: "inherit",
  });

  if (ownedImage)
    execFileSync(
      "docker",
      ["build", "-f", "apps/media-worker/Dockerfile", "-t", workerImage, "."],
      { stdio: "inherit" },
    );

  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(uid && gid, "the Unix worker fixture requires a nonroot Linux host identity");
  docker([
    "run",
    "--init",
    "--detach",
    "--name",
    workerName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${uid}:${gid}`,
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--pids-limit",
    "64",
    "--tmpfs",
    `/scratch:rw,noexec,nosuid,size=96m,uid=${uid},gid=${gid},mode=0700`,
    "--mount",
    `type=bind,source=${directory},target=/run/hyori-media`,
    workerImage,
  ]);
  await waitFor(socketReady, "isolated worker did not expose its private Unix socket");
  assert.equal(
    docker([
      "inspect",
      "--format",
      "{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}",
      workerName,
    ]),
    "none true 536870912 64",
  );
  assert.ok(
    !docker(["inspect", "--format", "{{json .Config.Env}}", workerName]).match(
      /HYORI_(STORAGE|AUTH|DATABASE)|AWS_/,
    ),
  );
  console.log(
    `Isolated worker image: ${docker(["image", "inspect", "--format", "{{.Id}}", workerImage])}`,
  );
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
  }, "PostgreSQL did not become ready");
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
  }, "RustFS did not become ready");
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
        HYORI_MEDIA_WORKER_SOCKET: socketPath,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitFor(async () => {
      if (backend?.exitCode !== null) throw new Error("Rust media backend exited before readiness");

      try {
        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    }, "Rust media backend did not become ready");
  };

  await start();
  const admin = client(origin);
  const owner = client(origin);

  const administrator = await admin.sdk.rpc.auth.setup({
    setupToken,
    email: "admin@example.test",
    name: "Admin",
    password: randomBytes(24).toString("hex"),
  });

  const ownerPassword = randomBytes(24).toString("hex");

  const user = await admin.sdk.rpc.admin.createUser({
    email: "owner@example.test",
    name: "Owner",
    password: ownerPassword,
  });

  await owner.sdk.rpc.auth.login({ email: "owner@example.test", password: ownerPassword });
  const pictures = await owner.sdk.rpc.files.createFolder({ parentId: null, name: "Pictures" });
  await owner.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  const media = [];
  let originalBytes = 0;

  for (const [extension, mime] of [
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
    ["avif", "image/avif"],
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["mov", "video/quicktime"],
  ] as const) {
    const bytes = await Bun.file(
      new URL(`../apps/server/tests/fixtures/media/red.${extension}`, import.meta.url),
    ).arrayBuffer();

    const file = await owner.sdk.uploads.start({
      parentId: pictures.id,
      file: new File([bytes], `red.${extension}`, { type: mime }),
    }).result;

    originalBytes += bytes.byteLength;
    media.push({ file, bytes });
  }

  await waitFor(
    async () =>
      (await owner.sdk.rpc.photos.timeline({})).items.every(
        (item) => item.derivative?.status === "ready",
      ),
    "all eight formats did not produce durable derivatives",
  );
  const timeline = await owner.sdk.rpc.photos.timeline({});
  assert.equal(timeline.items.length, 8);

  for (const { file, bytes } of media) {
    const item = timeline.items.find((item) => item.id === file.id)!;
    assert.ok(item.derivative?.status === "ready");
    assert.equal(item.derivative.kind, file.mimeType.startsWith("video/") ? "poster" : "thumbnail");
    assert.ok(item.derivative?.url);
    assert.notEqual(item.derivative.url, item.previewUrl);
    assert.match(item.previewUrl, /^\/api\/storage\/previews\//);
    const response = await owner.get(item.derivative.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.ok(response.headers.has("etag"));
    const normalized = await response.arrayBuffer();
    assert.ok(normalized.byteLength <= 256 * 1024);
    // The label alone proves nothing: the bytes must be a RIFF container holding WebP.
    const container = new Uint8Array(normalized);
    assert.equal(String.fromCharCode(...container.subarray(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...container.subarray(8, 12)), "WEBP");
    await Bun.write(join(directory, "verified.webp"), normalized);
    docker([
      "exec",
      workerName,
      "/usr/bin/ffmpeg",
      "-v",
      "error",
      "-threads",
      "1",
      "-i",
      "/run/hyori-media/verified.webp",
      "-f",
      "null",
      "-",
    ]);
    await rm(join(directory, "verified.webp"));
    assert.deepEqual(await (await owner.get(item.previewUrl)).arrayBuffer(), bytes);
  }

  assert.equal(
    (await owner.sdk.rpc.auth.status({})).user?.usedBytes,
    originalBytes,
    "cache artifacts do not consume original quota",
  );
  const first = media[0]!.file;
  const old = await owner.sdk.rpc.media.get({ id: first.id });
  assert.ok(old.status === "ready");
  await assert.rejects(admin.sdk.rpc.media.get({ id: first.id }), { code: "access.denied" });
  assert.equal((await admin.get(old.url!)).status, 403);

  const share = await owner.sdk.rpc.shares.create({
    itemId: pictures.id,
    recipientId: administrator.id,
    public: false,
    role: "viewer",
  });

  await admin.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  assert.equal((await admin.sdk.rpc.photos.timeline({})).items.length, 8);
  await admin.sdk.rpc.media.retry({ id: first.id });
  assert.equal((await admin.get(old.url!)).status, 200);
  await owner.sdk.rpc.shares.revoke({ id: share.id });
  assert.equal((await admin.get(old.url!)).status, 403);
  const gif = media.find((entry) => entry.file.mimeType === "image/gif")!.bytes;
  await owner.sdk.uploads.start({
    parentId: pictures.id,
    replaceId: first.id,
    file: new File([gif], first.name, { type: "image/gif" }),
  }).result;
  assert.equal((await owner.get(old.url!)).status, 404);
  const charged = (await owner.sdk.rpc.auth.status({})).user?.usedBytes;
  await waitFor(
    async () => (await owner.sdk.rpc.media.get({ id: first.id })).status === "ready",
    "replacement derivative did not become ready",
  );
  assert.equal((await owner.sdk.rpc.auth.status({})).user?.usedBytes, charged);
  const version = (await owner.sdk.rpc.files.versions({ id: first.id })).items[0]!;
  await owner.sdk.rpc.files.restoreVersion({ id: first.id, versionId: version.id });
  const restored = await owner.sdk.rpc.media.get({ id: first.id });
  assert.ok(restored.status === "ready");
  assert.equal(
    restored.url!.split("?")[0],
    old.url!.split("?")[0],
    "restored immutable source reuses canonical cache",
  );

  const invalid = await owner.sdk.uploads.start({
    parentId: pictures.id,
    file: new File(["<html>not an image</html>"], "invalid.png", { type: "image/png" }),
  }).result;

  await waitFor(
    async () => (await owner.sdk.rpc.media.get({ id: invalid.id })).status === "unsupported",
    "malformed media did not fail honestly",
  );
  assert.ok(!("url" in (await owner.sdk.rpc.media.get({ id: invalid.id }))));
  const original = await owner.sdk.downloads.open({ id: invalid.id });
  assert.equal(await new Response(original.stream).text(), "<html>not an image</html>");
  docker(["stop", "--time", "2", workerName]);

  const outage = await owner.sdk.uploads.start({
    parentId: pictures.id,
    file: new File([media[0]!.bytes], "outage.png", { type: "image/png" }),
  }).result;

  const downloadable = await owner.sdk.downloads.open({ id: outage.id });
  assert.deepEqual(await new Response(downloadable.stream).arrayBuffer(), media[0]!.bytes);
  await waitFor(
    async () => (await owner.sdk.rpc.media.get({ id: outage.id })).status === "failed",
    "worker outage did not exhaust the bounded automatic budget",
  );
  backend!.kill("SIGTERM");
  assert.equal(await backend!.exited, 0);
  docker(["start", workerName]);
  await waitFor(socketReady, "worker did not restart");
  await start();
  assert.equal((await owner.sdk.rpc.media.get({ id: outage.id })).status, "failed");
  await owner.sdk.rpc.media.retry({ id: outage.id });
  await waitFor(
    async () => (await owner.sdk.rpc.media.get({ id: outage.id })).status === "ready",
    "explicit retry did not recover after restart",
  );
  const shared = await admin.sdk.rpc.files.createFolder({ parentId: null, name: "Contributions" });
  await admin.sdk.rpc.shares.create({
    itemId: shared.id,
    recipientId: user.id,
    public: false,
    role: "contributor",
  });

  const contribution = await owner.sdk.uploads.start({
    parentId: shared.id,
    file: new File([media[0]!.bytes], "preserved.png", { type: "image/png" }),
  }).result;

  await waitFor(
    async () => (await admin.sdk.rpc.media.get({ id: contribution.id })).status === "ready",
    "contribution derivative did not become ready",
  );
  const preserved = await admin.sdk.rpc.media.get({ id: contribution.id });
  assert.ok(preserved.status === "ready");
  await admin.sdk.rpc.admin.deleteUser({ userId: user.id, confirmEmail: "owner@example.test" });
  await waitFor(
    async () => !(await admin.sdk.rpc.admin.users({})).items.some((entry) => entry.id === user.id),
    "account/derivative cleanup did not finish",
  );
  assert.equal((await admin.get(preserved.url!)).status, 200);
  assert.equal((await admin.sdk.rpc.auth.status({})).user?.usedBytes, 101);
  assert.notEqual((await owner.get(old.url!)).status, 200);
  console.log(
    "Real Rust -> public vanilla SDK -> isolated Unix media worker: eight decoded thumbnail/poster formats, original viewer preservation, canonical restore reuse, unchanged original quota, private/shared/revoked access, malformed rejection, bounded outage failure and explicit retry after restart, and account-purge contribution preservation passed. No browser fidelity or performance claim.",
  );
} finally {
  for (const sdk of clients) sdk.dispose();
  proxy?.stop(true);

  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await backend.exited;
  }

  for (const name of [workerName, postgresName, storageName]) {
    try {
      docker(["rm", "--force", name]);
    } catch {
      /* Only this fixture's unique resources are addressed. */
    }
  }

  await rm(directory, { recursive: true, force: true });

  if (ownedImage) {
    try {
      docker(["image", "rm", workerImage]);
    } catch {
      /* The fixture may have failed before building its private image. */
    }
  }
}

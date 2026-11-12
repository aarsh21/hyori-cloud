import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient } from "@hyori-cloud/client-sdk";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const suffix = randomBytes(8).toString("hex");
const postgresName = `hyori-admin-sdk-pg-${suffix}`;
const storageName = `hyori-admin-sdk-fs-${suffix}`;
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
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

function client(origin: string) {
  const cookies = new Map<string, string>();

  const sdk = createClient({
    baseUrl: `${origin}/api/rpc`,
    fetch: async (input, init) => {
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
    },
  });

  clients.push(sdk);

  return sdk;
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
      if (backend?.exitCode !== null) throw new Error("Rust admin fixture exited before readiness");

      try {
        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    }, "Rust admin fixture did not become ready");
  };

  await start();
  const admin = client(origin);
  const owner = client(origin);
  const other = client(origin);
  const visitor = client(origin);

  const administrator = await admin.rpc.auth.setup({
    setupToken,
    email: "admin@example.test",
    name: "Admin",
    password: randomBytes(24).toString("hex"),
  });

  const ownerPassword = randomBytes(24).toString("hex");

  const ownerAccount = await admin.rpc.admin.createUser({
    email: "owner@example.test",
    name: "Owner",
    password: ownerPassword,
  });

  await owner.rpc.auth.login({ email: "owner@example.test", password: ownerPassword });
  const otherPassword = randomBytes(24).toString("hex");

  const otherAccount = await admin.rpc.admin.createUser({
    email: "other@example.test",
    name: "Other",
    password: otherPassword,
  });

  await other.rpc.auth.login({ email: "other@example.test", password: otherPassword });
  await assert.rejects(owner.rpc.admin.users({}), { code: "access.denied" });
  await assert.rejects(visitor.rpc.admin.users({}), { code: "auth.required" });
  await assert.rejects(
    admin.rpc.admin.deleteUser({ userId: administrator.id, confirmEmail: "admin@example.test" }),
    { code: "access.denied" },
  );
  const pictures = await owner.rpc.files.createFolder({ parentId: null, name: "private-pictures" });

  const destination = await other.rpc.files.createFolder({
    parentId: null,
    name: "surviving-destination",
  });

  await other.rpc.shares.create({
    itemId: destination.id,
    recipientId: ownerAccount.id,
    role: "contributor",
    public: false,
  });

  const png = await Bun.file(
    new URL("../apps/server/tests/fixtures/media/red.png", import.meta.url),
  ).arrayBuffer();

  const contributed = await owner.uploads.start({
    parentId: destination.id,
    file: new File([png], "surviving.png", { type: "image/png" }),
  }).result;

  const pending = owner.uploads.start({
    parentId: destination.id,
    file: new File([png], "pending.png", { type: "image/png" }),
  });

  pending.subscribe(() => {
    if (pending.getSnapshot().checkpoint) pending.pause();
  });
  await assert.rejects(pending.result);
  assert.equal(pending.getSnapshot().status, "paused");
  assert.equal((await other.rpc.auth.status({})).user?.usedBytes, 101);

  const original = await owner.uploads.start({
    parentId: pictures.id,
    file: new File([png], "private-original.png", { type: "image/png" }),
  }).result;

  await owner.uploads.start({
    parentId: pictures.id,
    replaceId: original.id,
    file: new File([png], original.name, { type: "image/png" }),
  }).result;
  assert.equal((await owner.rpc.files.versions({ id: original.id })).items.length, 1);

  const trashed = await owner.uploads.start({
    parentId: pictures.id,
    file: new File([png], "private-trash.png", { type: "image/png" }),
  }).result;

  await owner.rpc.files.trash({ id: trashed.id });
  await owner.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  const album = await owner.rpc.photos.createAlbum({ name: "private-album" });
  await owner.rpc.photos.addToAlbum({ albumId: album.id, fileIds: [original.id, contributed.id] });
  const link = await owner.rpc.shares.create({ itemId: original.id, public: true, role: "viewer" });
  await visitor.rpc.shares.resolve({ token: link.url!.split("/").at(-1)! });
  assert.equal((await visitor.rpc.files.get({ id: original.id })).id, original.id);
  await admin.rpc.admin.createInvite({ email: "owner@example.test" });
  await assert.rejects(admin.rpc.files.get({ id: original.id }), { code: "access.denied" });
  assert.equal(
    (await admin.rpc.admin.setQuota({ userId: ownerAccount.id, quotaBytes: 0 })).quotaBytes,
    0,
  );

  const denied = owner.uploads.start({
    parentId: pictures.id,
    file: new File([png], "denied.png", { type: "image/png" }),
  });

  await assert.rejects(denied.result);
  assert.equal(denied.getSnapshot().status, "failed");
  assert.equal((await owner.rpc.files.get({ id: original.id })).id, original.id);
  await admin.rpc.admin.setQuota({ userId: ownerAccount.id, quotaBytes: 1_000_000 });

  // Actual public folder operations cross a metadata batch; no private database lifecycle shortcuts.
  for (let index = 0; index < 270; index++) {
    await owner.rpc.files.createFolder({ parentId: pictures.id, name: `private-child-${index}` });
  }

  const users = await admin.rpc.admin.users({});
  assert.equal(users.items.length, 3);
  assert.equal(users.items.find((user) => user.id === ownerAccount.id)?.usedBytes, 303);
  assert.equal(users.items.find((user) => user.id === otherAccount.id)?.reservedBytes, 101);
  const next = await admin.rpc.admin.users({ cursor: users.items[0]!.id });
  assert.deepEqual(
    next.items.map((user) => user.id),
    users.items.slice(1).map((user) => user.id),
  );
  assert.ok(!JSON.stringify(users).includes("private-"));
  assert.ok(!JSON.stringify(users).includes("owners/"));
  await assert.rejects(
    admin.rpc.admin.deleteUser({ userId: ownerAccount.id, confirmEmail: "Owner@example.test" }),
    { code: "input.invalid" },
  );

  const deleted = await admin.rpc.admin.deleteUser({
    userId: ownerAccount.id,
    confirmEmail: "owner@example.test",
  });

  assert.equal(deleted.state, "pending");
  assert.deepEqual(Object.keys(deleted).sort(), ["deletedObjects", "state", "userId"]);
  assert.equal((await owner.rpc.auth.status({})).user, null);
  await assert.rejects(visitor.rpc.files.get({ id: original.id }));
  await assert.rejects(
    owner.rpc.auth.login({ email: "owner@example.test", password: ownerPassword }),
  );
  await assert.rejects(admin.rpc.admin.setQuota({ userId: ownerAccount.id, quotaBytes: 99 }), {
    code: "resource.conflict",
  });
  assert.equal(
    (await admin.rpc.admin.users({})).items.find((user) => user.id === otherAccount.id)
      ?.reservedBytes,
    0,
  );
  backend!.kill("SIGTERM");
  assert.equal(await backend!.exited, 0);
  await start();
  // Observe a safe query; maintenance, not repeated delete commands or SDK orchestration, advances work.
  await waitFor(
    async () =>
      !(await admin.rpc.admin.users({})).items.some((user) => user.id === ownerAccount.id),
    "Server maintenance did not finish account purge after restart",
  );
  assert.equal((await other.rpc.files.get({ id: contributed.id })).ownerId, otherAccount.id);
  const download = await other.downloads.open({ id: contributed.id });
  assert.deepEqual(await new Response(download.stream).arrayBuffer(), png);
  assert.equal((await other.rpc.auth.status({})).user?.usedBytes, 101);
  assert.equal((await admin.rpc.auth.status({})).user?.id, administrator.id);
  assert.equal((await admin.rpc.auth.status({})).initialized, true);
  await assert.rejects(admin.rpc.files.get({ id: contributed.id }), { code: "access.denied" });
  await admin.rpc.auth.logout({});
  await assert.rejects(admin.rpc.admin.users({}), { code: "auth.required" });
  console.log(
    "Real Rust -> proxy -> public vanilla SDK admin: current admin/session privacy, users/cursor/aggregates, quota below usage, exact confirmation/protected bootstrap, originals/history/trash/Photos/shares, 270-folder bounded purge, immediate revocation, restart-owned continuation, pending-contribution reservation release and committed-contribution byte preservation passed.",
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

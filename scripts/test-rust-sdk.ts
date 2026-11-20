import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient } from "@hyori-cloud/client-sdk";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const postgresName = `hyori-rust-sdk-${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const setupToken = randomBytes(32).toString("hex");
const authSecret = randomBytes(32).toString("hex");
const testPassword = randomBytes(24).toString("hex");
const clients: ReturnType<typeof createClient>[] = [];
let backend: ReturnType<typeof startBackend> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;

function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, POSTGRES_PASSWORD: password },
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

function startBackend(databaseUrl: string, origin: string, bind: string) {
  return Bun.spawn(["target/debug/hyori-server"], {
    env: {
      ...build.env,
      APP_ENV: "development",
      APP_ORIGIN: origin,
      HYORI_DATABASE_URL: databaseUrl,
      HYORI_SETUP_TOKEN: setupToken,
      HYORI_AUTH_SECRET: authSecret,
      HYORI_SERVER_BIND: bind,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function waitForReady(url: string) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (backend?.exitCode !== null && backend?.exitCode !== undefined)
      throw new Error("Rust SDK fixture backend exited before readiness");

    try {
      if ((await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // Startup may still be connecting to PostgreSQL and applying migrations.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Rust SDK fixture backend did not become ready");
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
        const name = pair.slice(0, separator);

        if (separator < 1) throw new Error("Invalid cookie returned by Rust fixture");

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
  const address = docker(["port", postgresName, "5432/tcp"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const databaseUrl = `postgres://hyori_sdk:${password}@${address}/hyori_sdk`;
  const deadline = Date.now() + 30_000;
  let postgresReady = false;

  while (Date.now() < deadline) {
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
      postgresReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.ok(postgresReady, "PostgreSQL fixture did not become ready");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const backendUrl = reservation.url.origin;
  const bind = reservation.url.host;
  reservation.stop(true);

  let handle: (request: Request) => Promise<Response> = async () =>
    new Response(null, { status: 503 });

  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handle(request) });
  const origin = proxy.url.origin;
  handle = createBackendProxy({ origin, backendUrl });
  backend = startBackend(databaseUrl, origin, bind);
  await waitForReady(backendUrl);

  const admin = client(origin);
  assert.deepEqual(await admin.rpc.auth.status({}), { initialized: false, user: null });

  const first = await admin.rpc.auth.setup({
    setupToken,
    email: "owner@example.test",
    name: "Owner",
    password: testPassword,
  });

  assert.equal(first.role, "admin");
  assert.equal((await admin.rpc.auth.status({})).user?.id, first.id);
  const invite = await admin.rpc.admin.createInvite({ email: "member@example.test" });
  const member = client(origin);

  const joined = await member.rpc.auth.acceptInvite({
    token: invite.token,
    email: "member@example.test",
    name: "Member",
    password: testPassword,
  });

  assert.equal(joined.role, "user");
  await assert.rejects(member.rpc.admin.createInvite({}), { code: "access.denied" });
  const folder = await admin.rpc.files.createFolder({ parentId: null, name: "  Café  " });
  assert.equal(folder.name, "Café");
  assert.equal((await admin.rpc.files.list({ parentId: null })).items[0]?.id, folder.id);
  assert.deepEqual((await member.rpc.files.list({ parentId: null })).items, []);
  await member.rpc.files.createFolder({ parentId: null, name: "Private-only" });
  assert.deepEqual((await admin.rpc.files.list({ search: "Private-only" })).items, []);

  const {
    items: [recipient],
  } = await admin.rpc.users.search({ query: "  EMBER  " });

  assert.deepEqual(recipient, { id: joined.id, name: joined.name, email: joined.email });
  assert.ok(recipient);

  const direct = await admin.rpc.shares.create({
    itemId: folder.id,
    role: "viewer",
    recipientId: recipient.id,
    public: false,
  });

  assert.deepEqual(
    (await admin.rpc.shares.list({ itemId: folder.id })).items[0]?.recipient,
    recipient,
  );
  assert.equal((await member.rpc.files.list({ view: "shared" })).items[0]?.id, folder.id);
  await assert.rejects(member.rpc.files.createFolder({ parentId: folder.id, name: "Denied" }), {
    code: "access.denied",
  });
  const updated = await admin.rpc.shares.update({ id: direct.id, role: "contributor" });
  assert.deepEqual(updated, { ...direct, role: "contributor" });

  const memberFolder = await member.rpc.files.createFolder({
    parentId: folder.id,
    name: "Member contribution",
  });

  assert.equal(memberFolder.ownerId, first.id);

  const link = await admin.rpc.shares.create({
    itemId: folder.id,
    role: "contributor",
    public: true,
  });

  assert.ok(link.url);
  const anonymous = client(origin);
  const token = new URL(link.url).pathname.split("/").at(-1)!;
  const resolved = await anonymous.rpc.shares.resolve({ token });
  assert.equal(resolved.requiresPassword, false);
  assert.equal(resolved.item?.id, folder.id);

  const contribution = await anonymous.rpc.files.createFolder({
    parentId: folder.id,
    name: "Contribution",
  });

  assert.equal(contribution.ownerId, first.id);
  await assert.rejects(anonymous.rpc.files.trash({ id: contribution.id }), {
    code: "access.denied",
  });
  await admin.rpc.shares.revoke({ id: link.id });
  // Revoking the guest's only grant leaves no authenticated or public-link authority.
  await assert.rejects(anonymous.rpc.files.list({ parentId: folder.id }), {
    code: "auth.required",
  });
  const destination = await admin.rpc.files.createFolder({ parentId: null, name: "Archive" });
  assert.equal(
    (await admin.rpc.files.move({ id: folder.id, parentId: destination.id })).parentId,
    destination.id,
  );
  assert.equal(
    (await admin.rpc.files.rename({ id: folder.id, name: "  Documents  " })).name,
    "Documents",
  );
  await admin.rpc.files.trash({ id: folder.id });
  assert.ok(
    (await admin.rpc.files.list({ view: "trash" })).items.some((item) => item.id === folder.id),
  );
  await admin.rpc.files.restore({ id: folder.id });
  assert.equal((await admin.rpc.files.list({ parentId: destination.id })).items[0]?.id, folder.id);
  await admin.rpc.shares.revoke({ id: direct.id });
  assert.deepEqual((await member.rpc.files.list({ view: "shared" })).items, []);
  await admin.rpc.auth.logout({});
  assert.equal((await admin.rpc.auth.status({})).user, null);
  await admin.rpc.auth.login({ email: "owner@example.test", password: testPassword });
  assert.equal((await admin.rpc.auth.status({})).user?.id, first.id);

  backend.kill("SIGTERM");
  assert.equal(
    await backend.exited,
    0,
    "HTTP and maintenance must stop cleanly before database close",
  );
  await assert.rejects(member.rpc.auth.status({}), { code: "service.unavailable" });
  fixtureSql(`
    INSERT INTO hyori_sessions(id,token_digest,user_id,created_at,expires_at)
      SELECT 'cleanup_fixture',repeat('a',64),id,now()-interval '2 days',now()-interval '1 day' FROM hyori_users WHERE email='owner@example.test';
    INSERT INTO hyori_grants(token_digest,share_id,created_at,expires_at)
      SELECT repeat('b',64),id,now()-interval '1 day',now()-interval '13 hours' FROM hyori_shares LIMIT 1;
    INSERT INTO hyori_invites(token_digest,issuer_id,expires_at)
      SELECT repeat('c',64),id,now()-interval '1 day' FROM hyori_users WHERE email='owner@example.test';
    INSERT INTO hyori_rate_limits(key_digest,window_start,attempts)
      VALUES (repeat('d',64),now()-interval '16 minutes',11);
  `);

  const staleRecords = `SELECT
    (SELECT count(*) FROM hyori_sessions WHERE id='cleanup_fixture') +
    (SELECT count(*) FROM hyori_grants WHERE token_digest=repeat('b',64)) +
    (SELECT count(*) FROM hyori_invites WHERE token_digest=repeat('c',64)) +
    (SELECT count(*) FROM hyori_rate_limits WHERE key_digest=repeat('d',64))`;

  assert.equal(fixtureSql(staleRecords), "4");
  backend = startBackend(databaseUrl, origin, bind);
  await waitForReady(backendUrl);
  const cleanupDeadline = Date.now() + 5000;

  while (fixtureSql(staleRecords) !== "0" && Date.now() < cleanupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(
    fixtureSql(staleRecords),
    "0",
    "Rust runtime must reclaim expired auth records at startup",
  );
  assert.equal((await member.rpc.auth.status({})).user?.id, joined.id);
  assert.equal((await admin.rpc.auth.status({})).user?.id, first.id);
  assert.equal((await admin.rpc.files.list({ parentId: destination.id })).items[0]?.id, folder.id);
  assert.deepEqual((await member.rpc.files.list({ view: "shared" })).items, []);
  assert.equal(
    docker([
      "exec",
      postgresName,
      "psql",
      "-U",
      "hyori_sdk",
      "-d",
      "hyori_sdk",
      "-Atc",
      "SELECT count(*) FROM hyori_sessions WHERE token_digest !~ '^[a-f0-9]{64}$'",
    ]),
    "0",
  );
  process.stdout.write(
    "PASS real Rust/PostgreSQL -> streaming web proxy -> public vanilla SDK auth/invite/private folders/people search/share creation and role changes/revocation/trash/logout/outage/process restart and runtime authentication cleanup.\n",
  );
} finally {
  for (const sdk of clients) sdk.dispose();
  proxy?.stop(true);

  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await backend.exited;
  }

  try {
    docker(["rm", "--force", postgresName]);
  } catch {
    // Startup may have failed before the uniquely named test container existed.
  }
}

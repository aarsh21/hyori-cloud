import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient } from "@hyori-cloud/client-sdk";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const suffix = randomBytes(8).toString("hex");
const postgresName = `hyori-photos-sdk-pg-${suffix}`;
const storageName = `hyori-photos-sdk-fs-${suffix}`;
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

  return {
    sdk,
    get: (url: string, range?: string) =>
      authenticatedFetch(new URL(url, origin), { headers: range ? { Range: range } : {} }),
  };
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
  handle = createBackendProxy({
    origin,
    backendUrl,
    request: async (request) => {
      const response = await fetch(request);

      if (
        new URL(request.url).pathname.startsWith("/api/storage/previews/") &&
        response.status === 206
      ) {
        assert.ok(
          response.headers.has("content-length"),
          "Rust supplies exact range length before Bun forwards its stream",
        );
      }

      return response;
    },
  });

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
        throw new Error("Rust Photos fixture exited before readiness");

      try {
        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    }, "Rust Photos fixture did not become ready");
  };

  await start();
  const admin = client(origin);
  const owner = client(origin);
  const visitor = client(origin);

  const administrator = await admin.sdk.rpc.auth.setup({
    setupToken,
    email: "admin@example.test",
    name: "Admin",
    password: randomBytes(24).toString("hex"),
  });

  const userPassword = randomBytes(24).toString("hex");
  await admin.sdk.rpc.admin.createUser({
    email: "owner@example.test",
    name: "Owner",
    password: userPassword,
  });
  await owner.sdk.rpc.auth.login({ email: "owner@example.test", password: userPassword });
  const pictures = await owner.sdk.rpc.files.createFolder({ parentId: null, name: "Pictures" });
  const nested = await owner.sdk.rpc.files.createFolder({ parentId: pictures.id, name: "Nested" });
  assert.deepEqual(await owner.sdk.rpc.photos.sources({}), { allMyFiles: false, folderIds: [] });

  const png = await Bun.file(
    new URL("../apps/server/tests/fixtures/media/red.png", import.meta.url),
  ).arrayBuffer();

  const uploaded = await owner.sdk.uploads.start({
    parentId: nested.id,
    file: new File([png], "one.png", { type: "image/png" }),
  }).result;

  const library = await owner.sdk.rpc.photos.library({ cursor: null });
  assert.deepEqual(
    library.items.map((item) => item.id),
    [uploaded.id],
  );
  assert.equal(library.items[0]?.dateSource, "upload");
  assert.equal(library.items[0]?.timelineDate, uploaded.createdAt.slice(0, 10));
  assert.deepEqual(await owner.sdk.rpc.photos.details({ id: uploaded.id }), {
    capture: null,
    location: null,
  });
  await owner.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  assert.equal((await owner.sdk.rpc.files.get({ id: uploaded.id })).id, uploaded.id);
  const timeline = await owner.sdk.rpc.photos.timeline({});
  assert.deepEqual(
    timeline.items.map((item) => item.id),
    [uploaded.id],
  );
  assert.match(timeline.items[0]!.previewUrl, /^\/api\/storage\/previews\//);
  const original = await owner.get(timeline.items[0]!.previewUrl);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.equal(original.headers.get("content-length"), String(png.byteLength));
  assert.equal(original.headers.get("cache-control"), "private, no-cache");
  assert.ok(original.headers.has("etag"));
  assert.equal(original.headers.get("x-content-type-options"), "nosniff");
  assert.match(original.headers.get("content-security-policy")!, /sandbox/);
  assert.match(original.headers.get("content-disposition")!, /^inline;/);
  assert.deepEqual(await original.arrayBuffer(), png);
  const metadata = await owner.sdk.rpc.files.preview({ id: uploaded.id });
  const ranged = await owner.get(metadata.url, "bytes=2-7");
  assert.equal(ranged.status, 206);

  // Bun can forward this stream as chunked; the Rust boundary above and direct HTTP suite assert its length.
  if (ranged.headers.has("content-length")) assert.equal(ranged.headers.get("content-length"), "6");
  assert.equal(ranged.headers.get("content-range"), `bytes 2-7/${png.byteLength}`);
  assert.deepEqual(await ranged.arrayBuffer(), png.slice(2, 8));
  const invalidRange = await owner.get(metadata.url, "bytes=99999-");
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-length"), "0");
  assert.equal((await invalidRange.arrayBuffer()).byteLength, 0);

  for (const [extension, mime] of [
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

    const item = await owner.sdk.uploads.start({
      parentId: nested.id,
      file: new File([bytes], `red.${extension}`, { type: mime }),
    }).result;

    const preview = await owner.sdk.rpc.files.preview({ id: item.id });
    const response = await owner.get(preview.url);
    assert.equal(response.status, 200, extension);
    assert.equal(response.headers.get("content-type"), mime);
    assert.deepEqual(await response.arrayBuffer(), bytes);
  }

  const outsideSources: string[] = [];

  for (const [name, type, bytes] of [
    ["html.png", "image/png", new TextEncoder().encode("<html><script>alert(1)</script>")],
    ["svg.png", "image/png", new TextEncoder().encode("<svg onload='alert(1)'/>")],
    ["unknown.png", "image/png", new TextEncoder().encode("unknown bytes")],
    ["mismatch.jpg", "image/jpeg", new Uint8Array(png)],
    ["active.svg", "image/svg+xml", new TextEncoder().encode("<svg/>")],
  ] as const) {
    const item = await owner.sdk.uploads.start({
      parentId: null,
      file: new File([bytes], name, { type }),
    }).result;

    if (type === "image/svg+xml")
      await assert.rejects(owner.sdk.rpc.files.preview({ id: item.id }), { code: "input.invalid" });
    else {
      outsideSources.push(item.id);
      const preview = await owner.sdk.rpc.files.preview({ id: item.id });
      assert.equal((await owner.get(preview.url)).status, 400);
      assert.equal((await owner.get(preview.url, "bytes=3-5")).status, 400);
    }

    const download = await owner.sdk.rpc.files.download({ id: item.id });
    const attachment = await owner.get(download.url);
    assert.equal(attachment.headers.get("content-type"), "application/octet-stream");
    assert.match(attachment.headers.get("content-disposition")!, /^attachment;/);
    assert.deepEqual(new Uint8Array(await attachment.arrayBuffer()), bytes);
  }

  const grant = await owner.sdk.rpc.shares.create({
    itemId: pictures.id,
    recipientId: administrator.id,
    public: false,
    role: "viewer",
  });

  await admin.sdk.rpc.photos.setSources({ allMyFiles: true, folderIds: [] });
  assert.equal(
    (await admin.sdk.rpc.photos.timeline({})).items.length,
    0,
    "All my files excludes incoming libraries",
  );
  await admin.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  assert.equal((await admin.sdk.rpc.photos.timeline({})).items.length, 8);

  const newMedia = await owner.sdk.uploads.start({
    parentId: nested.id,
    file: new File([png], "new.png", { type: "image/png" }),
  }).result;

  assert.equal((await admin.sdk.rpc.photos.timeline({})).items[0]?.id, newMedia.id);
  const album = await admin.sdk.rpc.photos.createAlbum({ name: "Personal references" });
  await admin.sdk.rpc.photos.addToAlbum({
    albumId: album.id,
    fileIds: [uploaded.id, newMedia.id, uploaded.id],
  });
  assert.equal((await admin.sdk.rpc.photos.albums({})).items[0]?.count, 2);
  assert.equal((await owner.sdk.rpc.photos.albums({})).items.length, 0);
  await assert.rejects(owner.sdk.rpc.photos.timeline({ albumId: album.id }), {
    code: "resource.notFound",
  });
  await admin.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [] });
  assert.equal((await admin.sdk.rpc.photos.timeline({})).items.length, 0);
  assert.equal((await admin.sdk.rpc.photos.timeline({ albumId: album.id })).items.length, 2);
  assert.equal((await owner.sdk.rpc.files.get({ id: uploaded.id })).id, uploaded.id);
  await admin.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
  await owner.sdk.rpc.shares.revoke({ id: grant.id });
  assert.equal((await admin.sdk.rpc.photos.sources({})).folderIds.length, 0);
  assert.equal((await admin.sdk.rpc.photos.timeline({})).items.length, 0);
  assert.equal((await admin.sdk.rpc.photos.timeline({ albumId: album.id })).items.length, 0);
  assert.equal((await admin.sdk.rpc.photos.albums({})).items[0]?.count, 2);
  await assert.rejects(
    admin.sdk.rpc.photos.addToAlbum({ albumId: album.id, fileIds: [uploaded.id] }),
    { code: "resource.notFound" },
  );
  await assert.rejects(admin.sdk.rpc.files.get({ id: uploaded.id }), { code: "access.denied" });
  assert.equal((await admin.get(metadata.url)).status, 403);
  assert.deepEqual(
    await admin.sdk.rpc.photos.setSources({
      allMyFiles: false,
      folderIds: [pictures.id, "missing"],
    }),
    { allMyFiles: false, folderIds: [] },
  );

  const link = await owner.sdk.rpc.shares.create({
    itemId: uploaded.id,
    public: true,
    role: "viewer",
    password: "preview-password",
  });

  const token = link.url!.split("/").at(-1)!;
  assert.equal((await visitor.get(metadata.url)).status, 403);
  await visitor.sdk.rpc.shares.unlock({ token, password: "preview-password" });
  assert.equal((await visitor.sdk.rpc.files.get({ id: uploaded.id })).id, uploaded.id);
  assert.equal((await visitor.get(metadata.url)).status, 200);
  await assert.rejects(visitor.sdk.rpc.files.versions({ id: uploaded.id }), {
    code: "access.denied",
  });

  const gif = await Bun.file(
    new URL("../apps/server/tests/fixtures/media/red.gif", import.meta.url),
  ).arrayBuffer();

  await owner.sdk.uploads.start({
    parentId: nested.id,
    replaceId: uploaded.id,
    file: new File([gif], "one.png", { type: "image/gif" }),
  }).result;
  assert.equal((await visitor.sdk.rpc.files.get({ id: uploaded.id })).mimeType, "image/gif");
  const replacedPreview = await visitor.sdk.rpc.files.preview({ id: uploaded.id });
  assert.notEqual(
    replacedPreview.url,
    metadata.url,
    "replacement must change the mounted image source",
  );
  assert.equal(
    (await owner.sdk.rpc.photos.timeline({})).items.find((item) => item.id === uploaded.id)
      ?.previewUrl,
    replacedPreview.url,
  );
  const current = await visitor.get(metadata.url);
  assert.equal(current.headers.get("content-type"), "image/gif");
  assert.deepEqual(await current.arrayBuffer(), gif);
  const versions = await owner.sdk.rpc.files.versions({ id: uploaded.id });
  const versionId = versions.items[0]!.id;
  await assert.rejects(visitor.sdk.rpc.files.preview({ id: uploaded.id, versionId }), {
    code: "access.denied",
  });
  const historical = await owner.sdk.rpc.files.preview({ id: uploaded.id, versionId });
  assert.deepEqual(await (await owner.get(historical.url)).arrayBuffer(), png);
  assert.equal((await visitor.get(historical.url)).status, 403);
  await owner.sdk.uploads.start({
    parentId: nested.id,
    replaceId: uploaded.id,
    file: new File(["<html>not an image</html>"], "one.png", { type: "image/png" }),
  }).result;
  assert.equal(
    (await visitor.get(metadata.url)).status,
    400,
    "every GET validates the current immutable object",
  );
  await owner.sdk.rpc.files.restoreVersion({ id: uploaded.id, versionId });
  const restoredPreview = await visitor.sdk.rpc.files.preview({ id: uploaded.id });
  assert.notEqual(restoredPreview.url, metadata.url);
  assert.notEqual(
    restoredPreview.url,
    replacedPreview.url,
    "restore must change the mounted image source too",
  );
  assert.deepEqual(await (await visitor.get(metadata.url)).arrayBuffer(), png);
  await owner.sdk.rpc.shares.revoke({ id: link.id });
  assert.equal((await visitor.get(metadata.url)).status, 403);
  await owner.sdk.rpc.files.trash({ id: uploaded.id });
  await assert.rejects(owner.sdk.rpc.files.get({ id: uploaded.id }), { code: "resource.notFound" });
  assert.equal((await owner.get(metadata.url)).status, 404);
  await owner.sdk.rpc.files.restore({ id: uploaded.id });

  // Real public uploads, not database inserts, provide >1 timeline page.
  for (let index = 0; index < 94; index++) {
    await owner.sdk.uploads.start({
      parentId: nested.id,
      file: new File([png], `page-${index}.png`, { type: "image/png" }),
    }).result;
  }

  const first = await owner.sdk.rpc.photos.timeline({});
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  const second = await owner.sdk.rpc.photos.timeline({ cursor: first.nextCursor });
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map((item) => item.id)).size, 103);
  const ownFirst = await owner.sdk.rpc.photos.library({});
  assert.equal(ownFirst.items.length, 100);
  assert.ok(ownFirst.nextCursor);
  const ownNext = await owner.sdk.rpc.photos.library({ cursor: ownFirst.nextCursor });
  assert.equal(ownNext.items.length, 7);
  assert.equal(ownNext.nextCursor, null);
  const automatic = [...ownFirst.items, ...ownNext.items];
  assert.deepEqual(
    automatic.map((item) => item.id).sort(),
    [...all.map((item) => item.id), ...outsideSources].sort(),
  );

  for (const [index, item] of automatic.entries()) {
    assert.equal(item.dateSource, "upload");
    assert.equal(item.timelineDate, item.createdAt.slice(0, 10));
    const previous = automatic[index - 1];

    if (previous) {
      assert.ok(
        previous.createdAt > item.createdAt ||
          (previous.createdAt === item.createdAt && previous.id > item.id),
      );
    }
  }

  for (let index = 1; index < all.length; index++) {
    const previous = all[index - 1]!;
    const item = all[index]!;
    assert.ok(
      previous.createdAt > item.createdAt ||
        (previous.createdAt === item.createdAt && previous.id > item.id),
    );
  }

  backend!.kill("SIGTERM");
  assert.equal(await backend!.exited, 0);
  await start();
  assert.deepEqual(await owner.sdk.rpc.photos.sources({}), {
    allMyFiles: false,
    folderIds: [pictures.id],
  });
  assert.equal((await admin.sdk.rpc.photos.albums({})).items[0]?.count, 2);
  await owner.sdk.rpc.files.trash({ id: pictures.id });
  assert.deepEqual((await owner.sdk.rpc.photos.sources({})).folderIds, []);
  assert.equal((await owner.sdk.rpc.photos.timeline({})).items.length, 0);
  assert.deepEqual(
    await owner.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] }),
    { allMyFiles: false, folderIds: [] },
  );
  await owner.sdk.rpc.files.restore({ id: pictures.id });
  await owner.sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [] });
  assert.equal((await owner.sdk.rpc.photos.timeline({})).items.length, 0);
  assert.equal((await owner.sdk.rpc.files.get({ id: newMedia.id })).id, newMedia.id);
  await owner.sdk.rpc.photos.setSources({ allMyFiles: true, folderIds: [] });
  assert.equal((await owner.sdk.rpc.photos.timeline({})).items.length, 100);
  console.log(
    "Real Rust -> web proxy -> public vanilla SDK Photos: 107-item automatic library, 103-item folder timeline, synthetic uploads in eight formats, albums, restart, revocation/trash/admin privacy, safe original byte ranges and MIME validation passed. No thumbnail, browser, decoder-fidelity or performance claim.",
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

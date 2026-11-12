import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createBackendProxy } from "@hyori-cloud/api";
import { createClient } from "@hyori-cloud/client-sdk";
import { z } from "zod";
import { syntheticDeckCraft } from "./artcraft/deckcraft-synthetic.ts";
import { createSyntheticEditorAssets } from "./editor-assets-fixture.ts";
import { rustBuildConfig } from "./rust-build-config.ts";

const build = rustBuildConfig();
const suffix = randomBytes(8).toString("hex");
const postgres = `hyori-editor-sdk-pg-${suffix}`;
const storage = `hyori-editor-sdk-fs-${suffix}`;
const password = randomBytes(32).toString("hex");
const setupToken = randomBytes(32).toString("hex");
const authSecret = randomBytes(32).toString("hex");
const storageAccess = randomBytes(24).toString("hex");
const storageSecret = randomBytes(32).toString("hex");
const created: string[] = [];
const clients: ReturnType<typeof createClient>[] = [];
let server: ReturnType<typeof Bun.spawn> | undefined;
let proxy: ReturnType<typeof Bun.serve> | undefined;
const signal = AbortSignal.timeout(180_000);

const pdf = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

const changedPdf = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj<</Type/Catalog /Lang(en)>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

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

async function ready(check: () => Promise<boolean>, message: string) {
  const end = Date.now() + 90_000;

  while (Date.now() < end) {
    if (await check()) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

function client(origin: string) {
  const cookies = new Map<string, string>();
  let loseCompletion = false;

  const authenticatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);

    if (cookies.size) headers.set("Cookie", [...cookies.values()].join("; "));

    const request = new Request(input, { ...init, headers });

    const operation =
      new URL(request.url).pathname === "/api/rpc"
        ? z.object({ operation: z.string() }).parse(await request.clone().json()).operation
        : undefined;

    const response = await fetch(request);

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      assert.ok(separator > 0);
      const name = pair.slice(0, separator);

      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, pair);
    }

    if (loseCompletion && operation === "editors.completeSave" && response.ok) {
      loseCompletion = false;
      await response.arrayBuffer();
      throw new Error("Synthetic lost durable completion reply");
    }

    return response;
  };

  const sdk = createClient({ baseUrl: `${origin}/api/rpc`, fetch: authenticatedFetch });
  clients.push(sdk);

  return {
    sdk,
    loseNextCompletion: () => {
      loseCompletion = true;
    },
  };
}

const editorAssets = await createSyntheticEditorAssets();

try {
  execFileSync(build.executable, ["build", "--locked", "--bin", "hyori-server", "-j", "2"], {
    env: build.env,
    stdio: "inherit",
  });
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    postgres,
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
  created.push(postgres);
  const postgresAddress = docker(["port", postgres, "5432/tcp"]);
  assert.match(postgresAddress, /^127\.0\.0\.1:\d+$/);

  await ready(async () => {
    try {
      docker([
        "exec",
        postgres,
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
    storage,
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
  const storageAddress = docker(["port", storage, "9000/tcp"]);
  assert.match(storageAddress, /^127\.0\.0\.1:\d+$/);

  await ready(async () => {
    try {
      return (await fetch(`http://${storageAddress}/health`, { signal: AbortSignal.timeout(1000) }))
        .ok;
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
    server = Bun.spawn(["target/debug/hyori-server"], {
      env: {
        ...build.env,
        APP_ENV: "development",
        APP_ORIGIN: origin,
        HYORI_DATABASE_URL: `postgres://hyori_sdk:${password}@${postgresAddress}/hyori_sdk`,
        HYORI_SETUP_TOKEN: setupToken,
        HYORI_AUTH_SECRET: authSecret,
        HYORI_SERVER_BIND: bind,
        HYORI_EDITOR_ASSETS_DIR: editorAssets.directory,
        HYORI_EDITOR_ASSETS_MANIFEST_SHA256: editorAssets.manifestSha256,
        HYORI_STORAGE_ENDPOINT: `http://${storageAddress}`,
        HYORI_STORAGE_REGION: "us-east-1",
        HYORI_STORAGE_BUCKET: `hyori-editor-${suffix}`,
        HYORI_STORAGE_ACCESS_KEY: storageAccess,
        HYORI_STORAGE_SECRET_KEY: storageSecret,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });

    await ready(async () => {
      if (server?.exitCode !== null) throw new Error("Rust editor fixture exited before readiness");

      try {
        return (await fetch(`${backendUrl}/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    }, "Rust editor fixture did not become ready");
  };

  await start();
  const owner = client(origin);
  await owner.sdk.rpc.auth.setup({
    setupToken,
    email: "owner@example.test",
    name: "Owner",
    password: randomBytes(24).toString("hex"),
  });

  const file = await owner.sdk.uploads.start({
    parentId: null,
    file: new File([pdf], "document.pdf", { type: "application/pdf" }),
  }).result;

  const backend = owner.sdk.editors.backend({ id: file.id, destination: { parentId: null } });
  await assert.rejects(backend.open({ signal }));

  // Explicit private gate plus verified non-executable fixture; never a vendor runtime approval.
  docker([
    "exec",
    postgres,
    "psql",
    "-U",
    "hyori_sdk",
    "-d",
    "hyori_sdk",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "UPDATE hyori_editor_assets SET enabled=true",
  ]);
  const document = await backend.open({ signal });
  assert.deepEqual(await backend.download(document, { signal }), pdf);
  const competitor = owner.sdk.editors.backend({ id: file.id });
  const competingDocument = await competitor.open({ signal });

  const save = {
    sessionId: document.sessionId,
    expectedRevision: document.revision,
    saveId: randomUUID(),
    output: { name: document.name, bytes: changedPdf, intent: "replace" as const },
  };

  owner.loseNextCompletion();
  const ambiguous = await backend.save(save, { signal });
  assert.notEqual(ambiguous.status, "saved");
  server!.kill("SIGTERM");
  assert.equal(await server!.exited, 0);
  await start();
  const persisted = await backend.save(save, { signal });
  assert.equal(persisted.status, "saved");

  if (persisted.status !== "saved") throw new Error("No persisted editor revision");

  assert.equal((await owner.sdk.rpc.files.versions({ id: file.id })).items.length, 1);
  assert.deepEqual(await backend.save(save, { signal }), persisted);

  const conflict = await competitor.save(
    {
      sessionId: competingDocument.sessionId,
      expectedRevision: competingDocument.revision,
      saveId: randomUUID(),
      output: { name: document.name, bytes: pdf, intent: "replace" },
    },
    { signal },
  );

  assert.equal(conflict.status, "conflict");
  await assert.rejects(backend.download(document, { signal }));
  const current = { ...document, revision: persisted.revision };
  assert.deepEqual(await backend.download(current, { signal }), changedPdf);

  const copy = await backend.save(
    {
      sessionId: current.sessionId,
      expectedRevision: current.revision,
      saveId: randomUUID(),
      output: { name: "copy.pdf", bytes: changedPdf, intent: "save-as" },
    },
    { signal },
  );

  assert.equal(copy.status, "saved");
  assert.equal((await owner.sdk.rpc.files.versions({ id: file.id })).items.length, 1);
  const noDestination = owner.sdk.editors.backend({ id: file.id });
  const noDestinationDocument = await noDestination.open({ signal });
  assert.equal(
    (
      await noDestination.save(
        {
          sessionId: noDestinationDocument.sessionId,
          expectedRevision: noDestinationDocument.revision,
          saveId: randomUUID(),
          output: { name: "unselected.pdf", bytes: pdf, intent: "save-as" },
        },
        { signal },
      )
    ).status,
    // No chosen destination is a certain no-write outcome, distinct from an ambiguous failure.
    "cancelled",
  );

  const native = new Uint8Array(syntheticDeckCraft());

  const deck = await owner.sdk.uploads.start({
    parentId: null,
    file: new File([native], "slides.deckcraft"),
  }).result;

  const deckBackend = owner.sdk.editors.backend({ id: deck.id, destination: { parentId: null } });
  const deckDocument = await deckBackend.open({ signal });
  assert.equal(deckDocument.version, "0.14.1-hyori-host.2");
  assert.equal(
    deckDocument.assetUrl,
    "/artcraft/deckcraft/0.14.1-hyori-host.2/index.html?host=parent",
  );
  assert.deepEqual(await deckBackend.download(deckDocument, { signal }), native);
  assert.equal(
    (
      await deckBackend.save(
        {
          sessionId: deckDocument.sessionId,
          expectedRevision: deckDocument.revision,
          saveId: `${randomUUID()}:1`,
          output: { name: "slides.pdf", bytes: pdf, intent: "export" },
        },
        { signal },
      )
    ).status,
    "saved",
  );
  assert.equal((await owner.sdk.rpc.files.versions({ id: deck.id })).items.length, 0);

  const link = await owner.sdk.rpc.shares.create({ itemId: file.id, public: true, role: "editor" });
  assert.ok(link.url);
  const token = link.url.split("/").at(-1)!;
  const anonymous = client(origin);
  await anonymous.sdk.rpc.shares.resolve({ token });
  const publicBackend = anonymous.sdk.editors.backend({ id: file.id });
  const publicDocument = await publicBackend.open({ signal });
  assert.equal(
    (
      await publicBackend.save(
        {
          sessionId: publicDocument.sessionId,
          expectedRevision: publicDocument.revision,
          saveId: randomUUID(),
          output: { name: publicDocument.name, bytes: pdf, intent: "replace" },
        },
        { signal },
      )
    ).status,
    "saved",
  );
  await owner.sdk.rpc.shares.revoke({ id: link.id });
  await assert.rejects(publicBackend.download(publicDocument, { signal }));

  const afterRevocation = await publicBackend.save(
    {
      sessionId: publicDocument.sessionId,
      expectedRevision: publicDocument.revision,
      saveId: randomUUID(),
      output: { name: publicDocument.name, bytes: pdf, intent: "replace" },
    },
    { signal },
  );

  assert.equal(afterRevocation.status, "access-ended");
  await Promise.all([
    backend.close(),
    competitor.close(),
    noDestination.close(),
    deckBackend.close(),
    publicBackend.close(),
  ]);

  for (let index = 0; index < 40; index += 1) {
    const attachment = owner.sdk.editors.backend({ id: file.id });
    await attachment.open({ signal });
    await attachment.close();
  }

  const automaticSignal = AbortSignal.timeout(180_000);

  const automaticFile = await owner.sdk.uploads.start(
    {
      parentId: null,
      file: new File([pdf], "automatic.pdf", { type: "application/pdf" }),
    },
    { signal: automaticSignal },
  ).result;

  const automaticBackend = owner.sdk.editors.backend({ id: automaticFile.id });
  const automaticDocument = await automaticBackend.open({ signal: automaticSignal });
  let automaticRevision = automaticDocument.revision;
  let firstAutomatic: Parameters<typeof automaticBackend.save>[0] | null = null;
  let lastAutomatic: Parameters<typeof automaticBackend.save>[0] | null = null;
  let lastAutomaticRevision: string | null = null;

  for (let index = 0; index < 140; index += 1) {
    const bytes = new TextEncoder().encode(
      `%PDF-1.7\n1 0 obj<</Type/Catalog /Lang(en-${index})>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    );

    const input = {
      sessionId: automaticDocument.sessionId,
      expectedRevision: automaticRevision,
      saveId: `automatic-${suffix}-${index}`,
      saveMode: "automatic" as const,
      output: { name: automaticDocument.name, bytes, intent: "replace" as const },
    };

    firstAutomatic ??= input;

    if (index === 130) owner.loseNextCompletion();
    let result = await automaticBackend.save(input, { signal: automaticSignal });

    if (index === 130) {
      assert.equal(result.status, "failed");
      server!.kill("SIGTERM");
      assert.equal(await server!.exited, 0);
      await start();
      result = await automaticBackend.save(input, { signal: automaticSignal });
    }

    assert.equal(result.status, "saved", `Automatic save ${index} did not complete`);

    if (result.status !== "saved") throw new Error("Automatic save returned no durable revision");
    assert.notEqual(result.revision, input.expectedRevision);
    automaticRevision = result.revision;
    lastAutomatic = input;
    lastAutomaticRevision = result.revision;

    if (index === 0)
      assert.equal((await owner.sdk.rpc.files.versions({ id: automaticFile.id })).items.length, 1);
  }

  assert.ok(firstAutomatic && lastAutomatic && lastAutomaticRevision);
  const replayedAutomatic = await automaticBackend.save(lastAutomatic, { signal: automaticSignal });
  assert.equal(replayedAutomatic.status, "saved");

  if (replayedAutomatic.status === "saved")
    assert.equal(replayedAutomatic.revision, lastAutomaticRevision);

  // A retired ID cannot become a new write by changing its expected revision or bytes.
  for (const input of [
    firstAutomatic,
    { ...lastAutomatic, expectedRevision: automaticRevision, saveId: firstAutomatic.saveId },
  ]) {
    assert.equal(
      (await automaticBackend.save(input, { signal: automaticSignal })).status,
      "conflict",
    );
  }

  assert.deepEqual(
    await automaticBackend.download(
      { ...automaticDocument, revision: automaticRevision },
      { signal: automaticSignal },
    ),
    lastAutomatic.output.bytes,
  );
  const automaticHistory = await owner.sdk.rpc.files.versions({ id: automaticFile.id });
  assert.ok(automaticHistory.items.length >= 1 && automaticHistory.items.length < 140);
  await automaticBackend.close();

  // A reused save ID cannot carry other bytes, a rename fences the open session, and an expired
  // session ends rather than writing.
  const fenced = await owner.sdk.uploads.start(
    { parentId: null, file: new File([pdf], "fenced.pdf", { type: "application/pdf" }) },
    { signal: automaticSignal },
  ).result;

  const fencedBackend = owner.sdk.editors.backend({ id: fenced.id });
  const fencedDocument = await fencedBackend.open({ signal: automaticSignal });

  const fencedSave = {
    sessionId: fencedDocument.sessionId,
    expectedRevision: fencedDocument.revision,
    saveId: randomUUID(),
    output: { name: fencedDocument.name, bytes: changedPdf, intent: "replace" as const },
  };

  const fencedSaved = await fencedBackend.save(fencedSave, { signal: automaticSignal });
  assert.equal(fencedSaved.status, "saved");

  if (fencedSaved.status !== "saved") throw new Error("No fenced editor revision");

  const reused = await fencedBackend.save(
    { ...fencedSave, output: { ...fencedSave.output, bytes: pdf } },
    { signal: automaticSignal },
  );

  assert.notEqual(reused.status, "saved");
  const fencedCurrent = { ...fencedDocument, revision: fencedSaved.revision };
  assert.deepEqual(
    await fencedBackend.download(fencedCurrent, { signal: automaticSignal }),
    changedPdf,
  );

  const expiring = owner.sdk.editors.backend({ id: fenced.id });
  const expiringDocument = await expiring.open({ signal: automaticSignal });
  assert.match(expiringDocument.sessionId, /^[A-Za-z0-9_-]+$/);
  docker([
    "exec",
    postgres,
    "psql",
    "-U",
    "hyori_sdk",
    "-d",
    "hyori_sdk",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `UPDATE hyori_editor_sessions SET expires_at=now() WHERE id='${expiringDocument.sessionId}'`,
  ]);

  const expired = await expiring.save(
    {
      sessionId: expiringDocument.sessionId,
      expectedRevision: expiringDocument.revision,
      saveId: randomUUID(),
      output: { name: expiringDocument.name, bytes: pdf, intent: "replace" },
    },
    { signal: automaticSignal },
  );

  assert.equal(expired.status, "access-ended");
  assert.equal(expired.status === "access-ended" ? expired.reason : null, "session-ended");

  await owner.sdk.rpc.files.rename({ id: fenced.id, name: "renamed.pdf" });
  assert.equal(
    (
      await fencedBackend.save(
        {
          sessionId: fencedDocument.sessionId,
          expectedRevision: fencedSaved.revision,
          saveId: randomUUID(),
          output: { name: fencedDocument.name, bytes: pdf, intent: "replace" },
        },
        { signal: automaticSignal },
      )
    ).status,
    "conflict",
  );
  await Promise.all([fencedBackend.close(), expiring.close()]);

  console.log(
    "Real public SDK editor persistence passed: bounded download, durable lost-reply/restart replay, conflicts, explicit copy/export, native Deck fixture, anonymous Editor and revocation, 40 sequential open/close cycles, 140 automatic replacements with checkpoint grouping, lost-reply/restart recovery past the old 128-save limit, and retired-ID mutation fenced without changing current bytes, reused save ID with other bytes, expired session and rename fenced. No browser/WASM/fidelity or measured speed approval.",
  );
} finally {
  for (const sdk of clients) await sdk.dispose();

  proxy?.stop(true);

  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await server.exited;
  }

  try {
    for (const name of created.reverse()) docker(["rm", "--force", name]);
  } finally {
    await editorAssets.dispose();
  }
}

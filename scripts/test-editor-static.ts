import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createGzipTransportSidecar } from "./artcraft/transport-sidecars.ts";
import { editorStaticHandler } from "./editor-static-handler.ts";

const directory = await mkdtemp(join(tmpdir(), "hyori-static-delivery-"));
const assets = join(directory, "assets");
const container = `hyori-static-delivery-${randomBytes(8).toString("hex")}`;
const path = "wordcraft/fixture/wordcraft-web-0123456789abcdef.js";
const original = Buffer.from(`// Non-executed synthetic transport fixture\n${"x".repeat(16_384)}`);

const compressed = createGzipTransportSidecar(
  {
    path,
    bytes: original.length,
    sha256: createHash("sha256").update(original).digest("hex"),
  },
  original,
).bytes;

let created = false;
let requestSequence = 0;

function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

try {
  await mkdir(join(assets, "wordcraft/fixture"), { recursive: true });
  await mkdir(join(assets, "legal"));
  await writeFile(join(assets, path), original);
  await writeFile(join(assets, `${path}.gz`), compressed);
  const wasmPath = "wordcraft/fixture/wordcraft-web-0123456789abcdef_bg.wasm";
  const wasmBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

  const wasmGzip = createGzipTransportSidecar(
    {
      path: wasmPath,
      bytes: wasmBytes.length,
      sha256: createHash("sha256").update(wasmBytes).digest("hex"),
    },
    wasmBytes,
  ).bytes;

  await writeFile(join(assets, wasmPath), wasmBytes);
  await writeFile(join(assets, `${wasmPath}.gz`), wasmGzip);
  await writeFile(
    join(assets, "wordcraft/fixture/index.html"),
    "<!doctype html><title>Synthetic fixture</title>",
  );
  await writeFile(
    join(assets, "legal/RUNTIME-NOTICE-INDEX.md"),
    "Synthetic test; no vendor payload.",
  );
  await writeFile(
    join(directory, "Caddyfile"),
    `{\n    admin off\n    auto_https off\n}\nhttp://:8080 {\n${editorStaticHandler}\n    handle {\n        respond 404\n    }\n}\n`,
  );
  docker([
    "create",
    "--name",
    container,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=4m,uid=1000,gid=1000",
    "--tmpfs=/config:rw,noexec,nosuid,size=4m,uid=1000,gid=1000",
    "--tmpfs=/data:rw,noexec,nosuid,size=4m,uid=1000,gid=1000",
    "-p",
    "127.0.0.1::8080",
    "--mount",
    `type=bind,src=${join(directory, "Caddyfile")},dst=/etc/caddy/Caddyfile,readonly`,
    "--mount",
    `type=bind,src=${assets},dst=/srv/artcraft,readonly`,
    "caddy:2",
  ]);
  created = true;
  docker(["start", container]);
  const address = docker(["port", container, "8080/tcp"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${address}`;
  const deadline = Date.now() + 15_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (docker(["inspect", "--format", "{{.State.Running}}", container]) !== "true") break;

    try {
      ready = (
        await fetch(`${origin}/artcraft/wordcraft/fixture/index.html`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;

      if (ready) break;
    } catch {
      /* Disposable loopback listener may still be binding. */
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!ready) {
    console.error(docker(["inspect", "--format", "{{json .State}}", container]));
    execFileSync("docker", ["logs", container], { stdio: "inherit", timeout: 10_000 });
  }

  assert.ok(ready, "Synthetic static host did not become ready; retained diagnostic above");

  async function request(asset: string, headers: readonly string[] = []) {
    const headerFile = join(directory, `headers-${requestSequence++}.txt`);

    const body = execFileSync("curl", [
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "--dump-header",
      headerFile,
      ...headers.flatMap((header) => ["--header", header]),
      `${origin}/artcraft/${asset}`,
    ]);

    const rawHeaders = await readFile(headerFile, "utf8");
    const status = Number(/^HTTP\/\S+ (\d+)/m.exec(rawHeaders)?.[1]);
    const parsed = new Headers();

    for (const line of rawHeaders.split("\r\n")) {
      const separator = line.indexOf(":");

      if (separator > 0) parsed.append(line.slice(0, separator), line.slice(separator + 1).trim());
    }

    return { status, headers: parsed, body };
  }

  const identity = await request(path, ["Accept-Encoding: identity"]);
  assert.equal(identity.status, 200);
  assert.deepEqual(identity.body, original);
  assert.match(identity.headers.get("cache-control") ?? "", /max-age=31536000, immutable/);
  assert.match(identity.headers.get("content-type") ?? "", /javascript/);
  assert.equal(identity.headers.get("content-encoding"), null);
  assert.equal(identity.headers.get("x-content-type-options"), "nosniff");
  assert.equal(identity.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(
    identity.headers.get("content-security-policy"),
    "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  );

  const gzip = await request(path, ["Accept-Encoding: gzip"]);
  assert.equal(gzip.status, 200);
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.match(gzip.headers.get("vary") ?? "", /accept-encoding/i);
  assert.deepEqual(
    gzip.body,
    compressed,
    "Server recompressed instead of serving the pinned sidecar",
  );
  assert.deepEqual(gunzipSync(gzip.body), original);

  const forbiddenGzip = await request(path, ["Accept-Encoding: gzip;q=0, identity"]);
  assert.equal(forbiddenGzip.headers.get("content-encoding"), null);
  assert.deepEqual(forbiddenGzip.body, original);

  const wasm = await request(wasmPath, ["Accept-Encoding: identity"]);
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.deepEqual(wasm.body, wasmBytes);
  const encodedWasm = await request(wasmPath, ["Accept-Encoding: gzip"]);
  assert.equal(encodedWasm.headers.get("content-type"), "application/wasm");
  assert.equal(encodedWasm.headers.get("content-encoding"), "gzip");
  assert.deepEqual(encodedWasm.body, wasmGzip);

  const range = await request(path, ["Accept-Encoding: identity", "Range: bytes=0-7"]);
  assert.equal(range.status, 206);
  assert.deepEqual(range.body, original.subarray(0, 8));
  assert.equal(range.headers.get("content-range"), `bytes 0-7/${original.length}`);

  const notModified = await request(path, [
    "Accept-Encoding: identity",
    `If-None-Match: ${identity.headers.get("etag")}`,
  ]);

  assert.equal(notModified.status, 304);
  assert.equal(notModified.body.length, 0);

  for (const asset of ["wordcraft/fixture/index.html", "legal/RUNTIME-NOTICE-INDEX.md"]) {
    const response = await request(asset);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
  }

  const missing = await request("wordcraft/fixture/missing-0123456789abcdef.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-cache");
  console.log(
    "PASS real Caddy: exact precompressed bytes, decoded identity, MIME/security headers, immutable existing hashed assets only, revalidated index/notices, missing404 not immutable, identity range206 and conditional304. Synthetic transport only; no editor startup/speed or live deployment claim.",
  );
} finally {
  if (created) docker(["rm", "--force", container]);
  await rm(directory, { recursive: true, force: true });
}

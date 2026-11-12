/** Local-stack proof. Uses the account created by measure-delivery.ts seed.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-media-revalidation.ts [--require-304] [--stop-local-storage]
 * The storage flag temporarily stops ONLY the orb's hyori-storage service, restoring it in finally.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createClient } from "@hyori-cloud/client-sdk";
import { z } from "zod";

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

const state = z
  .object({ email: z.string(), password: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        process.env.HYORI_DELIVERY_STATE ?? join(homedir(), "hyori-delivery/state.json"),
        "utf8",
      ),
    ),
  );

const require304 = process.argv.includes("--require-304");

function principal() {
  const cookies = new Map<string, string>();

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, origin), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        origin,
        cookie: [...cookies.values()].join("; "),
      },
    });

    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }

    return response;
  };

  const sdk = createClient({
    baseUrl: `${origin}/api/rpc`,
    fetch: (input, init) => request(String(input), init),
  });

  return { request, sdk };
}

const owner = principal();
const visitor = principal();

try {
  await owner.sdk.rpc.auth.login(state);
  const rpcOrigin = process.env.HYORI_DELIVERY_RUST_ORIGIN ?? origin;

  for (const [operation, input, expectedStatus] of [
    ["auth.status", {}, 200],
    ["files.get", { id: "missing" }, 404],
  ] as const) {
    const response = await owner.request(`${rpcOrigin}/api/rpc`, {
      method: "POST",
      headers: { host: new URL(origin).host, "content-type": "application/json" },
      body: JSON.stringify({ operation, input }),
    });

    assert.equal(response.status, expectedStatus);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    await response.arrayBuffer();
  }

  console.log("RPC success and error retain no-store");
  const png = await readFile("apps/server/tests/fixtures/media/red.png");

  const task = owner.sdk.uploads.start({
    parentId: null,
    file: new File([png], `revalidation-${Date.now()}.png`, { type: "image/png" }),
  });

  const file = await task.result;
  task.dispose();
  const preview = await owner.sdk.rpc.files.preview({ id: file.id });
  const first = await owner.request(preview.url);
  assert.equal(first.status, 200);
  assert.equal(
    first.headers.get("cache-control"),
    require304 ? "private, no-cache" : "private, no-store",
  );
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array(png));
  const etag = first.headers.get("etag") ?? '"baseline-has-no-etag"';
  const resources = [{ label: "preview", url: preview.url, etag }];
  const deadline = Date.now() + 30_000;
  let derivative = await owner.sdk.rpc.media.get({ id: file.id });

  while (derivative.status !== "ready" && Date.now() < deadline) {
    await Bun.sleep(250);
    derivative = await owner.sdk.rpc.media.get({ id: file.id });
  }

  assert.equal(derivative.status, "ready", "Run the real media worker for this proof");

  if (derivative.status !== "ready") throw new Error("Derivative unavailable");
  const thumbnail = await owner.request(derivative.url);
  assert.equal(thumbnail.status, 200);
  assert.equal(
    thumbnail.headers.get("cache-control"),
    require304 ? "private, no-cache" : "private, no-store",
  );
  assert.ok((await thumbnail.arrayBuffer()).byteLength > 0);
  resources.push({
    label: "thumbnail",
    url: derivative.url,
    etag: thumbnail.headers.get("etag") ?? '"baseline-has-no-etag"',
  });
  const samples = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const start = performance.now();
    const response = await owner.request(preview.url, { headers: { "If-None-Match": etag } });
    const bytes = (await response.arrayBuffer()).byteLength;
    samples.push({ status: response.status, bytes, ms: performance.now() - start });

    if (require304) {
      assert.equal(response.status, 304);
      assert.equal(bytes, 0);
      assert.equal(response.headers.get("cache-control"), "private, no-cache");
    }
  }

  console.log(
    JSON.stringify({
      case: "preview reuse",
      initialBytes: png.byteLength,
      cache: first.headers.get("cache-control"),
      hasEtag: first.headers.has("etag"),
      samples,
    }),
  );

  const repeatedThumbnail = await owner.request(resources[1]!.url, {
    headers: { "If-None-Match": resources[1]!.etag },
  });

  assert.equal(repeatedThumbnail.status, require304 ? 304 : 200);
  console.log(
    `thumbnail revalidation: ${repeatedThumbnail.status}, ${(await repeatedThumbnail.arrayBuffer()).byteLength} bytes`,
  );
  const stale = await owner.request(preview.url, { headers: { "If-None-Match": '"not-current"' } });
  assert.equal(stale.status, 200);
  await stale.arrayBuffer();
  const range = await owner.request(preview.url, { headers: { Range: "bytes=3-9" } });
  assert.equal(range.status, 206);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array(png.subarray(3, 10)));
  const original = await owner.sdk.rpc.files.download({ id: file.id });
  const bytes = await owner.request(original.url, { headers: { "If-None-Match": etag } });
  assert.equal(bytes.status, 200);
  assert.match(bytes.headers.get("cache-control")!, /no-store/);
  await bytes.arrayBuffer();
  console.log(
    "Original attachment still no-store; range bytes correct; mismatched ETag returns 200",
  );

  const link = await owner.sdk.rpc.shares.create({ itemId: file.id, public: true, role: "viewer" });
  const token = new URL(link.url!).pathname.split("/").at(-1)!;
  await visitor.sdk.rpc.shares.unlock({ token, password: "" });
  const allowed = await visitor.request(preview.url);
  assert.equal(allowed.status, 200);
  await allowed.arrayBuffer();
  await owner.sdk.rpc.shares.revoke({ id: link.id });

  for (const [label, client] of [
    ["revoked share", visitor],
    ["ended session", owner],
  ] as const) {
    if (label === "ended session") await owner.sdk.rpc.auth.logout({});

    for (const resource of resources) {
      const unconditional = await client.request(resource.url);

      const conditional = await client.request(resource.url, {
        headers: { "If-None-Match": resource.etag },
      });

      assert.ok(unconditional.status >= 400);
      assert.equal(conditional.status, unconditional.status);
      assert.match(conditional.headers.get("cache-control")!, /no-store/);
      console.log(
        `${resource.label}, ${label}: unconditional ${unconditional.status}, conditional ${conditional.status}`,
      );
      await unconditional.arrayBuffer();
      await conditional.arrayBuffer();
    }
  }

  await owner.sdk.rpc.auth.login(state);
  const expiry = Date.now() + 2500;

  const expiring = await owner.sdk.rpc.shares.create({
    itemId: file.id,
    public: true,
    role: "viewer",
    expiresAt: new Date(expiry).toISOString(),
  });

  await visitor.sdk.rpc.shares.unlock({
    token: new URL(expiring.url!).pathname.split("/").at(-1)!,
    password: "",
  });
  await Bun.sleep(Math.max(0, expiry - Date.now() + 50));

  for (const resource of resources) {
    const expired = await visitor.request(resource.url);

    const expiredConditional = await visitor.request(resource.url, {
      headers: { "If-None-Match": resource.etag },
    });

    assert.ok(expired.status >= 400);
    assert.equal(expiredConditional.status, expired.status);
    console.log(
      `${resource.label}, expired share: unconditional ${expired.status}, conditional ${expiredConditional.status}`,
    );
    await expired.arrayBuffer();
    await expiredConditional.arrayBuffer();
  }

  if (process.argv.includes("--stop-local-storage")) {
    assert.ok(require304, "Storage-outage proof requires --require-304");
    execFileSync("amp", ["orb", "service", "stop", "hyori-storage"]);

    try {
      for (const resource of resources) {
        const start = performance.now();

        const cached = await owner.request(resource.url, {
          headers: { "If-None-Match": resource.etag },
        });

        assert.equal(cached.status, 304);
        assert.equal((await cached.arrayBuffer()).byteLength, 0);
        console.log(
          `${resource.label}, storage stopped: conditional 304 in ${(performance.now() - start).toFixed(1)}ms`,
        );
        const uncached = await owner.request(resource.url, { signal: AbortSignal.timeout(10_000) });
        assert.equal(uncached.status, 503);
        await uncached.arrayBuffer();
        console.log("storage stopped: unconditional 503 (control)");
      }
    } finally {
      execFileSync("amp", ["orb", "service", "restart", "hyori-storage"]);
    }
  }

  await owner.sdk.rpc.files.trash({ id: file.id });
} finally {
  owner.sdk.dispose();
  visitor.sdk.dispose();
}

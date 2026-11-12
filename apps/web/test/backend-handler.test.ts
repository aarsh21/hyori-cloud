import { afterEach, expect, test } from "bun:test";
import { createWebBackendHandler } from "../src/server/backend-handler";

const origin = "https://cloud.example.test";
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);

  return server.url.origin;
}

function request(host = "cloud.example.test", extra: HeadersInit = {}) {
  return new Request("http://internal-nitro.test/api/rpc", {
    method: "POST",
    headers: { Host: host, Origin: origin, ...Object.fromEntries(new Headers(extra)) },
    body: JSON.stringify({ operation: "auth.status", input: {} }),
  });
}

test("maps the preserved public Host over a private HTTP hop without trusting forwarding headers", async () => {
  const backendUrl = serve(async (incoming) => {
    expect(incoming.headers.get("host")).toBe("cloud.example.test");
    expect(incoming.headers.get("origin")).toBe(origin);
    expect(incoming.headers.has("forwarded")).toBe(false);
    expect(incoming.headers.has("x-forwarded-host")).toBe(false);
    expect(incoming.headers.has("x-forwarded-proto")).toBe(false);
    expect(await incoming.json()).toEqual({ operation: "auth.status", input: {} });

    return Response.json({ ok: true, value: { initialized: false, user: null } });
  });

  const handler = createWebBackendHandler({ origin, backendUrl, production: true });

  const response = await handler(
    request("cloud.example.test", {
      Forwarded: "host=attacker.test;proto=http",
      "X-Forwarded-Host": "attacker.test",
      "X-Forwarded-Proto": "http",
    }),
  );

  expect(response.status).toBe(200);
});

test("fails closed on authority, cross-origin and missing cookie-write evidence", async () => {
  let calls = 0;

  const backendUrl = serve(() => {
    calls++;

    return Response.json({ ok: true });
  });

  const handler = createWebBackendHandler({ origin, backendUrl, production: true });
  expect(
    (await handler(request("attacker.test", { "X-Forwarded-Host": "cloud.example.test" }))).status,
  ).toBe(403);
  expect(
    (await handler(request("cloud.example.test", { Origin: "https://attacker.test" }))).status,
  ).toBe(403);
  const noOrigin = request("cloud.example.test", { Cookie: "hyori_session=opaque" });
  noOrigin.headers.delete("origin");
  expect((await handler(noOrigin)).status).toBe(403);
  expect(calls).toBe(0);
});

test("missing or unsafe config never connects and returns a private noncached 503", async () => {
  for (const config of [
    { origin, backendUrl: undefined, production: true },
    { origin: "http://cloud.example.test", backendUrl: "http://127.0.0.1:9", production: true },
    { origin, backendUrl: "https://secret:password@private.test", production: true },
    { origin, backendUrl: "http://private.test/prefix", production: true },
    { origin: "bad", backendUrl: "http://127.0.0.1:9", production: false },
  ]) {
    const response = await createWebBackendHandler(config)(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("password");
  }
});

test("an actual HTTP host preserves independent cookies, ranges, stream bytes and upstream failures", async () => {
  const backendUrl = serve((incoming) => {
    if (new URL(incoming.url).pathname === "/api/rpc") {
      const headers = new Headers();
      headers.append("set-cookie", "hyori_session=one; HttpOnly; Secure; Path=/");
      headers.append("set-cookie", "hyori_share=two; HttpOnly; Secure; Path=/");

      return new Response("rpc", { headers });
    }

    expect(incoming.headers.get("range")).toBe("bytes=2-4");

    return new Response(new Uint8Array([2, 3, 4]), {
      status: 206,
      headers: { "Content-Range": "bytes 2-4/8", "Content-Length": "3" },
    });
  });

  const handler = createWebBackendHandler({ origin, backendUrl, production: true });
  const host = serve(handler);

  const cookies = await fetch(`${host}/api/rpc`, {
    method: "POST",
    headers: { Host: "cloud.example.test", Origin: origin },
    body: "{}",
  });

  expect(cookies.headers.getSetCookie()).toHaveLength(2);

  const range = await fetch(`${host}/api/storage/files/file1`, {
    headers: { Host: "cloud.example.test", Range: "bytes=2-4" },
  });

  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-4/8");
  expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3, 4]);

  const unavailable = createWebBackendHandler({
    origin,
    backendUrl: "http://127.0.0.1:9",
    production: true,
  });

  expect((await unavailable(request())).status).toBe(503);
});

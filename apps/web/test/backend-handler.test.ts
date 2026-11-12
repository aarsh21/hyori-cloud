import { afterEach, expect, test } from "bun:test";
import { createWebBackendHandler } from "../src/server/backend-handler";
import { withOperations } from "../src/server/operations";

const origin = "https://cloud.example.test";
const servers: ReturnType<typeof Bun.serve>[] = [];

test("web readiness follows only the private backend and liveness stays independent", async () => {
  let backendStatus = 200;

  const backend = serve((request) => {
    expect(new URL(request.url).pathname).toBe("/health/ready");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();

    return new Response("private diagnostic", { status: backendStatus });
  });

  const host = withOperations(
    () => {
      throw new Error("Health probes must bypass application rendering.");
    },
    backend,
    () => {},
  );

  for (const expected of [200, 503]) {
    backendStatus = expected;

    if (expected === 503) await Bun.sleep(1050);

    const response = await host(
      new Request("http://host/health/ready", {
        headers: { Authorization: "Bearer never-forward", Cookie: "session=never-forward" },
      }),
    );

    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(expected === 200 ? "ok\n" : "unavailable\n");
    expect((await host(new Request("http://host/health/live"))).status).toBe(200);
  }

  const offline = withOperations(
    () => new Response("page"),
    "http://127.0.0.1:9",
    () => {},
  );

  expect((await offline(new Request("http://host/health/ready"))).status).toBe(503);
  expect((await offline(new Request("http://host/health/live"))).status).toBe(200);
});

test("internal SSR fetches do not create additional incoming access records", async () => {
  const lines: string[] = [];

  const host = withOperations(
    () => new Response("denied", { status: 403 }),
    undefined,
    (line) => lines.push(line),
  );

  const paths = [
    "/share/known-share-secret",
    "/api/storage/files/private-name.txt",
    "/api/rpc",
    "/assets/private-asset.js",
  ];

  for (const path of paths) {
    await host(
      new Request(`http://host${path}?token=known-query-secret`, {
        method: "POST",
        headers: {
          Cookie: "session=known-cookie-secret",
          Authorization: "Bearer known-auth-secret",
        },
        body: "known-body-secret",
      }),
    );
  }

  expect(lines).toEqual([]);
});

test("readiness coalesces concurrent probes and reuses both outcomes for one second", async () => {
  let calls = 0;
  let hanging = false;

  const backend = serve(async () => {
    calls++;
    await Bun.sleep(hanging ? 4000 : 40);

    return new Response("ready");
  });

  const host = withOperations(
    () => new Response("page"),
    backend,
    () => {},
  );

  const burst = () =>
    Promise.all(Array.from({ length: 80 }, () => host(new Request("http://host/health/ready"))));

  expect((await burst()).every((response) => response.status === 200)).toBe(true);
  expect(calls).toBe(1);
  hanging = true;
  const down = performance.now();
  expect((await burst()).every((response) => response.status === 200)).toBe(true);
  expect(calls).toBe(1);
  await Bun.sleep(1050);
  const pending = burst();
  expect((await host(new Request("http://host/health/live"))).status).toBe(200);
  await Bun.sleep(1100);
  const late = burst();
  expect((await pending).every((response) => response.status === 503)).toBe(true);
  expect((await late).every((response) => response.status === 503)).toBe(true);
  expect(performance.now() - down).toBeLessThan(3300);
  expect(calls).toBe(2);
  expect((await burst()).every((response) => response.status === 503)).toBe(true);
  expect(calls).toBe(2);
  await Bun.sleep(1050);
  hanging = false;
  expect((await burst()).every((response) => response.status === 200)).toBe(true);
  expect(calls).toBe(3);
}, 10000);

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

test("gateway opt-in retains original Node duplicate evidence across public-origin mapping", async () => {
  const backendUrl = serve((incoming) =>
    Response.json({ address: incoming.headers.get("x-hyori-client-address") }),
  );

  const handler = createWebBackendHandler({
    origin,
    backendUrl,
    production: true,
    gatewayClientAddressHeader: "x-forwarded-for",
  });

  for (const [rawHeaders, expected] of [
    [["X-Forwarded-For", "192.0.2.250, 203.0.113.8"], "203.0.113.8"],
    [["X-Forwarded-For", "192.0.2.250", "X-Forwarded-For", "203.0.113.8"], null],
  ] as const) {
    const incoming = Object.assign(
      request("cloud.example.test", {
        "X-Forwarded-For": "192.0.2.250, 203.0.113.8",
        "X-Hyori-Client-Address": "192.0.2.250",
      }),
      { runtime: { node: { req: { rawHeaders: [...rawHeaders] } } } },
    );

    expect(await (await handler(incoming)).json()).toEqual({ address: expected });
  }
});

test("missing or unsafe config never connects and returns a private noncached 503", async () => {
  for (const config of [
    { origin, backendUrl: undefined, production: true },
    { origin: "http://cloud.example.test", backendUrl: "http://127.0.0.1:9", production: true },
    { origin, backendUrl: "https://secret:password@private.test", production: true },
    { origin, backendUrl: "http://private.test/prefix", production: true },
    { origin: "bad", backendUrl: "http://127.0.0.1:9", production: false },
    {
      origin,
      backendUrl: "http://127.0.0.1:9",
      production: true,
      gatewayClientAddressHeader: "x-hyori-client-address",
    },
    {
      origin,
      backendUrl: "http://127.0.0.1:9",
      production: true,
      gatewayClientAddressHeader: "x-forwarded-for, x-real-ip",
    },
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

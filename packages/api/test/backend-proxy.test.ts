import { afterEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createBackendProxy } from "@hyori-cloud/api";

const origin = "https://cloud.example.test";
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startBackend(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);

  return server.url.origin;
}

function rpc(headers: HeadersInit = { Origin: origin }) {
  return new Request(`${origin}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify({ operation: "auth.status", input: {} }),
  });
}

describe("private Rust backend proxy", () => {
  test("only authorized preview and derivative responses allow mandatory revalidation", async () => {
    for (const path of [
      "previews/file1",
      "derivatives/file1/artifact1",
      "files/file1",
      "editors/session1",
    ]) {
      for (const status of [200, 304, 403]) {
        const handle = createBackendProxy({
          origin,
          backendUrl: "http://127.0.0.1:3002",
          request: async () =>
            new Response(null, {
              status,
              headers: { "cache-control": "private, no-cache", etag: '"immutable"' },
            }),
        });

        const response = await handle(
          new Request(`${origin}/api/storage/${path}`, {
            headers: { "If-None-Match": '"immutable"' },
          }),
        );

        const media = path.startsWith("previews/") || path.startsWith("derivatives/");

        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe(
          media && status !== 403 ? "private, no-cache" : "private, no-store",
        );
      }
    }
  });

  test("preserves the real RPC body, status and independent cookies", async () => {
    const backendUrl = startBackend(async (request) => {
      expect(await request.json()).toEqual({ operation: "auth.status", input: {} });
      expect(request.headers.get("host")).toBe("cloud.example.test");
      expect(request.headers.get("cookie")).toBe("hyori_session=opaque");
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append("Set-Cookie", "hyori_session=next; Path=/; Secure; HttpOnly");
      headers.append("Set-Cookie", "hyori_share=grant; Path=/; Secure; HttpOnly");

      return new Response(JSON.stringify({ ok: true, value: {} }), { headers });
    });

    const handle = createBackendProxy({ origin, backendUrl });
    const response = await handle(rpc({ Origin: origin, Cookie: "hyori_session=opaque" }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(await response.json()).toEqual({ ok: true, value: {} });
  });

  test("negotiates gzip only for the backend's opt-in, with identical decoded JSON", async () => {
    const json = JSON.stringify("x".repeat(1022));
    const hint = "x-hyori-rpc-compressible";

    const handle = createBackendProxy({
      origin,
      backendUrl: "http://127.0.0.1:3002",
      request: async (request) => {
        expect(request.headers.has(hint)).toBe(false);
        expect(request.headers.get("accept-encoding")).toBe("identity");

        return new Response(json, {
          headers: {
            "content-type": "application/json",
            "content-length": "1024",
            vary: "Origin",
            [hint]: "1",
          },
        });
      },
    });

    for (const [accept, encoding, status] of [
      [undefined, null, 200],
      ["", null, 200],
      ["br, zstd", null, 200],
      ["gzip;q=0, *;q=1", null, 200],
      ["gzip, gzip;q=0", null, 200],
      ["gzip;q=1.5", null, 200],
      ["gzip;q=0.5, identity;q=0.9", null, 200],
      ["br, GZip;q=0.7", "gzip", 200],
      ["br, *;q=0.5", "gzip", 200],
      ["*;q=0, gzip;q=1", "gzip", 200],
      ["*;q=0, identity;q=1", null, 200],
      ["br, *;q=0", null, 406],
      ["br, gzip;q=0, identity;q=0", null, 406],
    ] as const) {
      const request = rpc({ Origin: origin, [hint]: "1" });

      if (accept !== undefined) request.headers.set("accept-encoding", accept);

      const response = await handle(request);

      expect(response.status, accept).toBe(status);
      expect(response.headers.get("content-encoding"), accept).toBe(encoding);
      expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
      expect(response.headers.has(hint)).toBe(false);

      if (encoding === "gzip") {
        expect(response.headers.has("content-length")).toBe(false);
        const bytes = new Uint8Array(await response.arrayBuffer());
        expect(bytes.byteLength).toBeLessThan(1024);
        expect(gunzipSync(bytes).toString()).toBe(json);
      } else if (status === 200) {
        expect(response.headers.get("content-length")).toBe("1024");
        expect(await response.text()).toBe(json);
      } else {
        expect(await response.json()).toMatchObject({ ok: false });
      }
    }
  });

  test("leaves large unmarked RPCs, cookies, errors and bodies under 1024 bytes as identity", async () => {
    const hint = "x-hyori-rpc-compressible";

    for (const [size, status, extra] of [
      [2048, 200, {}],
      [2048, 200, { [hint]: "1", "set-cookie": "test=credential" }],
      [2048, 403, { [hint]: "1" }],
      [1023, 200, { [hint]: "1" }],
    ] as const) {
      const json = JSON.stringify("x".repeat(size - 2));

      const handle = createBackendProxy({
        origin,
        backendUrl: "http://127.0.0.1:3002",
        request: async () =>
          new Response(json, {
            status,
            headers: {
              "content-type": "application/json",
              "content-length": String(size),
              ...extra,
            },
          }),
      });

      const response = await handle(
        rpc({ Origin: origin, "accept-encoding": "gzip", [hint]: "1" }),
      );

      expect(response.status).toBe(status);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("vary")).toBe(false);
      expect(response.headers.has(hint)).toBe(false);
      expect(await response.text()).toBe(json);
    }
  });

  test("forwards byte ranges and returns the original binary stream and headers", async () => {
    const backendUrl = startBackend((request) => {
      expect(new URL(request.url).search).toBe("?version=version1");
      expect(request.headers.get("range")).toBe("bytes=2-4");

      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": "bytes 2-4/8",
          "Content-Length": "3",
          "Content-Disposition": 'attachment; filename="safe.bin"',
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Accept-Ranges": "bytes",
          "X-Hyori-Rpc-Compressible": "1",
        },
      });
    });

    const response = await createBackendProxy({ origin, backendUrl })(
      new Request(`${origin}/api/storage/files/file1?version=version1`, {
        headers: { Range: "bytes=2-4", "Accept-Encoding": "gzip" },
      }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("x-hyori-rpc-compressible")).toBe(false);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/8");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4]);
  });

  test("forwards storage HEAD as HEAD without a body, keeping the object's metadata", async () => {
    const backendUrl = startBackend((request) => {
      expect(request.method).toBe("HEAD");
      expect(request.headers.get("cookie")).toBe("hyori_session=opaque");

      return new Response(null, {
        headers: { "Content-Type": "application/pdf", "Content-Length": "8" },
      });
    });

    const response = await createBackendProxy({ origin, backendUrl })(
      new Request(`${origin}/api/storage/files/file1`, {
        method: "HEAD",
        headers: { Cookie: "hyori_session=opaque" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe("8");
    expect(await response.text()).toBe("");
  });

  test("passes the upload body as a stream without reading it before the upstream request", async () => {
    let streamed = false;

    const handle = createBackendProxy({
      origin,
      backendUrl: "http://127.0.0.1:3002",
      request: async (request) => {
        expect(request.body).toBeInstanceOf(ReadableStream);
        streamed = true;
        expect(await request.text()).toBe("part bytes");

        return Response.json({ ok: true, value: {} });
      },
    });

    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers: { Origin: origin },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("part bytes"));
          controller.close();
        },
      }),
      duplex: "half",
    };

    expect(
      (await handle(new Request(`${origin}/api/storage/uploads/upload1/1`, init))).status,
    ).toBe(200);
    expect(streamed).toBe(true);
  });

  test("rejects cross-origin requests and cookie writes without CSRF evidence before forwarding", async () => {
    let calls = 0;

    const handle = createBackendProxy({
      origin,
      backendUrl: "http://127.0.0.1:3002",
      request: async () => {
        calls++;

        return Response.json({ ok: true });
      },
    });

    expect((await handle(rpc({ Origin: "https://attacker.example" }))).status).toBe(403);
    expect((await handle(rpc({ Cookie: "hyori_session=opaque" }))).status).toBe(403);
    expect((await handle(rpc({ Origin: origin, "Sec-Fetch-Site": "cross-site" }))).status).toBe(
      403,
    );
    expect(
      (await handle(new Request("https://attacker.example/api/storage/files/file1"))).status,
    ).toBe(403);
    expect(calls).toBe(0);
  });

  test("strips untrusted forwarding and hop headers without forging missing Origin evidence", async () => {
    const handle = createBackendProxy({
      origin,
      backendUrl: "http://127.0.0.1:3002",
      request: async (request) => {
        for (const name of [
          "forwarded",
          "x-forwarded-host",
          "x-forwarded-proto",
          "x-real-ip",
          "x-hyori-client-address",
          "x-hop",
        ])
          expect(request.headers.has(name)).toBe(false);
        expect(request.headers.has("origin")).toBe(false);
        expect(request.redirect).toBe("manual");

        return new Response("not followed", {
          status: 307,
          headers: {
            Location: "https://attacker.example/",
            Connection: "x-private-hop",
            "X-Private-Hop": "secret",
          },
        });
      },
    });

    const response = await handle(
      rpc({
        Cookie: "hyori_session=opaque",
        "Sec-Fetch-Site": "same-origin",
        Forwarded: "for=attacker",
        "X-Forwarded-Host": "attacker.example",
        "X-Forwarded-Proto": "http",
        "X-Real-IP": "127.0.0.1",
        "X-Hyori-Client-Address": "192.0.2.250",
        Connection: "x-hop",
        "X-Hop": "ignored",
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.has("x-private-hop")).toBe(false);
  });

  test("returns explicit service failure without leaking upstream errors", async () => {
    const handle = createBackendProxy({
      origin,
      backendUrl: "http://127.0.0.1:3002",
      request: async () => {
        throw new Error("private backend connection detail");
      },
    });

    const response = await handle(rpc());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private backend connection detail");
  });

  test("rejects an open-proxy path or method and unsafe operator configuration", async () => {
    const handle = createBackendProxy({ origin, backendUrl: "http://127.0.0.1:3002" });
    expect((await handle(new Request(`${origin}/admin`))).status).toBe(404);
    expect((await handle(new Request(`${origin}/api/rpc`))).status).toBe(405);
    expect(
      (await handle(new Request(`${origin}/api/storage/files/file1`, { method: "DELETE" }))).status,
    ).toBe(405);
    expect((await handle(new Request(`${origin}/api/rpc`, { method: "HEAD" }))).status).toBe(405);

    for (const backendUrl of [
      "file:///etc/passwd",
      "https://user:password@example.test",
      "http://localhost/prefix",
    ])
      expect(() => createBackendProxy({ origin, backendUrl })).toThrow();
  });
});

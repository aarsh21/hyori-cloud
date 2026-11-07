import { afterEach, describe, expect, test } from "bun:test";
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
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, value: {} });
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
        },
      });
    });

    const response = await createBackendProxy({ origin, backendUrl })(
      new Request(`${origin}/api/storage/files/file1?version=version1`, {
        headers: { Range: "bytes=2-4" },
      }),
    );

    expect(response.status).toBe(206);
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

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFrontHandler } from "./front-proxy.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];

const sha256 = (text: string) => createHash("sha256").update(text).digest("base64");

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);

  for (const cleanup of cleanups.splice(0)) cleanup();
});

function startStub(onRequest: (request: Request) => Promise<Response>) {
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: onRequest });

  servers.push(server);

  return `http://127.0.0.1:${server.port}`;
}

function rpc(operation: string, signal = new AbortController().signal) {
  return new Request("https://localhost/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, input: {} }),
    signal,
  });
}

describe("abandoning a request at the gateway", () => {
  test("the host really receives it, then really loses it, and the browser gets no reply", async () => {
    let received = "";

    const lost = Promise.withResolvers<void>();

    const nitroUrl = startStub(async (request) => {
      received = await request.text();
      request.signal.addEventListener("abort", () => lost.resolve());
      await lost.promise;

      return new Response("{}");
    });

    const front = createFrontHandler({ nitroUrl });

    front.abandonRequest((record) => record.operation === "uploads.complete", 5, true);

    const reply = await front.handle(rpc("uploads.complete"), "http/1.1");

    await expect(reply.text()).rejects.toThrow();
    await lost.promise;
    expect(JSON.parse(received)).toEqual({ operation: "uploads.complete", input: {} });
    expect(front.records[0]?.outcome).toBe("abandoned");
  });

  test("only the matching request is abandoned, and only once", async () => {
    const nitroUrl = startStub(async () => Response.json({ ok: true, value: {} }));
    const front = createFrontHandler({ nitroUrl });

    front.abandonRequest((record) => record.operation === "uploads.complete", 0, false);

    const other = await front.handle(rpc("files.list"), "http/1.1");

    expect(await other.json()).toEqual({ ok: true, value: {} });

    const first = await front.handle(rpc("uploads.complete"), "http/1.1");

    await expect(first.text()).rejects.toThrow();

    const retried = await front.handle(rpc("uploads.complete"), "http/1.1");

    expect(await retried.json()).toEqual({ ok: true, value: {} });
    expect(front.records.map(({ outcome }) => outcome)).toEqual([
      "complete",
      "abandoned",
      "complete",
    ]);
  });
});

describe("holding a request at the gateway", () => {
  test("a hold released before its request arrives does not let a later hold's request through", async () => {
    const nitroUrl = startStub(async () => Response.json({ ok: true, value: {} }));
    const front = createFrontHandler({ nitroUrl });
    const isPart = (record: { operation: string | null }) => record.operation === "uploads.part";

    front.hold(isPart)();

    const release = front.hold(isPart);
    let answered = false;

    const reply = front.handle(rpc("uploads.part"), "http/1.1").then((response) => {
      answered = true;

      return response;
    });

    await Bun.sleep(50);
    expect(answered).toBe(false);
    release();
    expect(await (await reply).json()).toEqual({ ok: true, value: {} });
  });
});

describe("the editor bundle route", () => {
  function bundleFront() {
    const parent = mkdtempSync(join(tmpdir(), "hyori-front-bundle-"));
    const root = join(parent, "bundle");

    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    mkdirSync(join(root, "wordcraft/0.14.0"), { recursive: true });
    writeFileSync(
      join(root, "wordcraft/0.14.0/index.html"),
      '<!doctype html><script type="module">start();</script><style>body{}</style>',
    );
    writeFileSync(
      join(root, "runtime-bundle-manifest.json"),
      JSON.stringify({
        editors: [
          {
            app: "wordcraft",
            version: "0.14.0",
            assetUrl: "/artcraft/wordcraft/0.14.0/index.html",
          },
        ],
      }),
    );
    writeFileSync(join(root, "wordcraft/0.14.0/app_bg.wasm"), new Uint8Array([0, 97, 115, 109]));
    writeFileSync(join(root, "wordcraft/0.14.0/app.js"), "export {};");
    writeFileSync(join(parent, "front-outside.txt"), "outside");

    const nitroUrl = startStub(async () => new Response("from the host"));

    return { root, front: createFrontHandler({ nitroUrl, staticRoot: root }) };
  }

  const at = (path: string) => new Request(`https://localhost${path}`);

  test("serves the file with the deployment contract's headers", async () => {
    const { front } = bundleFront();
    const reply = await front.handle(at("/artcraft/wordcraft/0.14.0/index.html?host=parent"), "h2");

    expect(reply.status).toBe(200);
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
    expect(reply.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(reply.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${sha256("start();")}'; style-src 'self' 'sha256-${sha256("body{}")}'`,
    );
    expect(reply.headers.get("cache-control")).toBe("no-cache");
    expect(reply.headers.get("content-type")).toStartWith("text/html");
  });

  test("gives WebAssembly and scripts the types browsers require", async () => {
    const { front } = bundleFront();

    expect(
      (await front.handle(at("/artcraft/wordcraft/0.14.0/app_bg.wasm"), "h2")).headers.get(
        "content-type",
      ),
    ).toBe("application/wasm");
    expect(
      (await front.handle(at("/artcraft/wordcraft/0.14.0/app.js"), "h2")).headers.get(
        "content-type",
      ),
    ).toBe("text/javascript");
  });

  test("a missing asset is a 404, never the app's fallback page", async () => {
    const { front } = bundleFront();
    const reply = await front.handle(at("/artcraft/wordcraft/0.14.0/missing.js"), "h2");

    expect(reply.status).toBe(404);
    expect(await reply.text()).not.toContain("from the host");
  });

  test("a directory isn't served", async () => {
    const { front } = bundleFront();

    expect((await front.handle(at("/artcraft/wordcraft/0.14.0/"), "h2")).status).toBe(404);
  });

  test("nothing outside the bundle can be reached", async () => {
    const { front } = bundleFront();

    // URLs normalize dot segments away first, so some of these simply leave the route for the host.
    for (const path of [
      "/artcraft/%2e%2e/front-outside.txt",
      "/artcraft/../front-outside.txt",
      "/artcraft/wordcraft/%2e%2e/%2e%2e/%2e%2e/front-outside.txt",
    ]) {
      expect(await (await front.handle(at(path), "h2")).text()).not.toContain("outside");
    }

    expect((await front.handle(at("/artcraft/..%2ffront-outside.txt"), "h2")).status).toBe(404);
    expect(
      (await front.handle(at("/artcraft/wordcraft%2f..%2f..%2ffront-outside.txt"), "h2")).status,
    ).toBe(404);
  });

  test("everything else still goes to the host", async () => {
    const { front } = bundleFront();
    const reply = await front.handle(at("/"), "h2");

    expect(await reply.text()).toBe("from the host");
  });
});

import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { createServer } from "node:http";
import { once } from "node:events";
import { Schema } from "@hyori-cloud/lib/effect";

test("real HTTP truncation after observed headers is surfaced as SDK_TRANSPORT", async () => {
  const headersObserved = Promise.withResolvers<void>();

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "1024" });
    response.flushHeaders();
    response.write('{"ok":true,"value":');
    void headersObserved.promise.then(() => response.destroy());
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = Schema.decodeUnknownSync(
    Schema.Struct({ port: Schema.Int.pipe(Schema.between(1, 65535)) }),
  )(server.address());

  const client = createClient({
    baseUrl: `http://127.0.0.1:${address.port}/api/rpc`,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      headersObserved.resolve();

      return response;
    },
  });

  try {
    await expect(client.rpc.auth.status({})).rejects.toMatchObject({ code: "SDK_TRANSPORT" });
  } finally {
    client.dispose();
    headersObserved.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function brokenBody() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true,"value":'));
      // Firefox reports an interrupted response stream this way even with a live caller signal.
      controller.error(new DOMException("Connection lost after headers", "AbortError"));
    },
  });
}

test("a dropped RPC response body is a transport failure, not a schema mismatch", async () => {
  const client = createClient({ fetch: async () => new Response(brokenBody()) });

  try {
    await expect(client.rpc.auth.status({})).rejects.toMatchObject({ code: "SDK_TRANSPORT" });
  } finally {
    client.dispose();
  }
});

test("fully received invalid JSON and invalid envelopes remain protocol failures", async () => {
  for (const body of ['{"ok":', '{"ok":true}', '{"ok":"yes","value":null}']) {
    const client = createClient({ fetch: async () => new Response(body) });

    try {
      await expect(client.rpc.auth.status({})).rejects.toMatchObject({ code: "SDK_PROTOCOL" });
    } finally {
      client.dispose();
    }
  }
});

test("gateway unavailable statuses without an RPC envelope are retryable unavailable failures", async () => {
  for (const status of [502, 503, 504]) {
    for (const body of ["", "<html>Gateway unavailable</html>", '{"error":"upstream"}']) {
      const client = createClient({ fetch: async () => new Response(body, { status }) });

      try {
        await expect(client.rpc.auth.status({})).rejects.toMatchObject({
          code: "service.unavailable",
        });
      } finally {
        client.dispose();
      }
    }
  }
});

test("gateway status does not hide a valid declared RPC error or a malformed success", async () => {
  const client = createClient({
    fetch: async () =>
      Response.json(
        { ok: false, error: { code: "access.denied", message: "Denied" } },
        { status: 503 },
      ),
  });

  const malformed = createClient({
    fetch: async () => Response.json({ ok: true, value: "invalid" }, { status: 502 }),
  });

  try {
    await expect(client.rpc.auth.status({})).rejects.toMatchObject({ code: "access.denied" });
    await expect(malformed.rpc.auth.status({})).rejects.toMatchObject({ code: "SDK_TRANSPORT" });
  } finally {
    client.dispose();
    malformed.dispose();
  }
});

test("cancellation after RPC headers remains cancellation even when reading the body fails", async () => {
  const controller = new AbortController();

  const client = createClient({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(body) {
            controller.abort();
            body.error(new TypeError("Synthetic cancelled response body"));
          },
        }),
      ),
  });

  try {
    await expect(client.rpc.auth.status({}, { signal: controller.signal })).rejects.toMatchObject({
      code: "SDK_CANCELLED",
    });
  } finally {
    client.dispose();
  }
});

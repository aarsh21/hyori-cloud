import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createNodeBackendProxy } from "@hyori-cloud/api/node";
import { Schema } from "@hyori-cloud/lib/effect";

const origin = "https://cloud.example.test";

test("gateway address opt-in strips spoofed evidence, selects the last entry and rejects ambiguous or invalid IPs", async () => {
  const fixture = await backend((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.headers));
  });

  try {
    for (const gatewayClientAddressHeader of [undefined, "X-Forwarded-For", "X-Gateway-Client"]) {
      const proxy = createNodeBackendProxy({
        origin,
        backendUrl: fixture.url,
        gatewayClientAddressHeader,
      });

      const source = gatewayClientAddressHeader ?? "X-Forwarded-For";

      for (const [value, rawHeaders, expected] of [
        ["203.0.113.8", undefined, "203.0.113.8"],
        ["2001:db8::5", undefined, "2001:db8::5"],
        ["198.51.100.99, 203.0.113.8", [source, "198.51.100.99, 203.0.113.8"], "203.0.113.8"],
        ["198.51.100.99, 203.0.113.8", [source, "198.51.100.99", source, "203.0.113.8"], undefined],
        ["198.51.100.99, 203.0.113.8", undefined, undefined],
        ["garbage", undefined, undefined],
        ["203.0.113.8, garbage", [source, "203.0.113.8, garbage"], undefined],
        ["203.0.113.8:443", undefined, undefined],
        ["[2001:db8::5]", undefined, undefined],
        ["fe80::1%eth0", undefined, undefined],
        ["203.0.113.999", undefined, undefined],
      ] as const) {
        const response = await proxy(
          new Request(`${origin}/api/storage/files/file1`, {
            headers: {
              [source]: value,
              "X-Hyori-Client-Address": "192.0.2.250",
              Forwarded: "for=192.0.2.250",
              "X-Real-IP": "192.0.2.250",
              "X-Forwarded-Host": "attacker.test",
            },
          }),
          rawHeaders,
        );

        const headers = Schema.decodeUnknownSync(
          Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        )(await response.json());

        assert.equal(
          headers["x-hyori-client-address"],
          gatewayClientAddressHeader ? expected : undefined,
          `${source}: ${value}`,
        );

        for (const name of ["forwarded", "x-real-ip", "x-forwarded-for", "x-forwarded-host"])
          assert.equal(headers[name], undefined);
      }
    }
  } finally {
    fixture.close();
  }
});

async function backend(listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("Node transport preserves public Host, streamed response headers and separate cookies", async () => {
  const fixture = await backend((request, response) => {
    assert.equal(request.headers.host, "cloud.example.test");
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.range, "bytes=2-4");
    assert.equal(request.headers["x-forwarded-host"], undefined);
    response.writeHead(206, {
      "Content-Range": "bytes 2-4/8",
      "Content-Length": "3",
      "Set-Cookie": ["hyori_session=one; Secure; HttpOnly", "hyori_share=two; Secure; HttpOnly"],
    });
    response.end(new Uint8Array([2, 3, 4]));
  });

  try {
    const proxy = createNodeBackendProxy({ origin, backendUrl: fixture.url });

    const response = await proxy(
      new Request(`${origin}/api/storage/files/file1`, {
        headers: { Origin: origin, Range: "bytes=2-4", "X-Forwarded-Host": "attacker.test" },
      }),
    );

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "3");
    assert.equal(response.headers.get("content-range"), "bytes 2-4/8");
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 3, 4]));
  } finally {
    fixture.close();
  }
});

test("Node transport decodes compressed upstream responses with Fetch-compatible headers", async () => {
  const compressed = gzipSync("streamed compressed response");

  const fixture = await backend((_request, response) => {
    response.writeHead(200, {
      "Content-Encoding": "gzip",
      "Content-Length": String(compressed.byteLength),
    });
    response.end(compressed);
  });

  try {
    const response = await createNodeBackendProxy({ origin, backendUrl: fixture.url })(
      new Request(`${origin}/api/storage/files/file1`),
    );

    assert.equal(await response.text(), "streamed compressed response");
    assert.equal(response.headers.has("content-encoding"), false);
    assert.equal(response.headers.has("content-length"), false);
  } finally {
    fixture.close();
  }
});

test(
  "Node transport sends upload chunks before source completion and forwards cancellation",
  { timeout: 5000 },
  async () => {
    let firstChunk = () => {};
    let aborted = () => {};

    const received = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });

    const disconnected = new Promise<void>((resolve) => {
      aborted = resolve;
    });

    const fixture = await backend((request) => {
      request.once("data", () => firstChunk());
      request.once("aborted", () => aborted());
    });

    const controller = new AbortController();
    let cancelled = false;

    try {
      const proxy = createNodeBackendProxy({ origin, backendUrl: fixture.url });

      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        headers: { Origin: origin, "Content-Length": "65536" },
        body: new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        duplex: "half",
        signal: controller.signal,
      };

      const result = proxy(new Request(`${origin}/api/storage/uploads/upload1/1`, init));
      const rejected = assert.rejects(result, /abort/i);
      await received;
      controller.abort();
      await rejected;
      await disconnected;
      assert.equal(cancelled, true);
    } finally {
      controller.abort();
      fixture.close();
    }
  },
);

test(
  "client AbortSignal after response headers still fails the body stream",
  { timeout: 5000 },
  async () => {
    const fixture = await backend((_request, response) => {
      response.writeHead(200);
      response.write(new Uint8Array([1]));
    });

    const controller = new AbortController();

    try {
      const response = await createNodeBackendProxy({ origin, backendUrl: fixture.url })(
        new Request(`${origin}/api/storage/files/file1`, { signal: controller.signal }),
      );

      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await assert.rejects(reader.read());
    } finally {
      controller.abort();
      fixture.close();
    }
  },
);

test(
  "upstream truncation fails the body instead of reporting successful EOF",
  { timeout: 5000 },
  async () => {
    const fixture = await backend((_request, response) => {
      response.writeHead(200, { "Content-Length": "100" });
      response.write(new Uint8Array([1]));
      setImmediate(() => response.destroy());
    });

    try {
      const response = await createNodeBackendProxy({ origin, backendUrl: fixture.url })(
        new Request(`${origin}/api/storage/files/file1`),
      );

      await assert.rejects(response.arrayBuffer());
    } finally {
      fixture.close();
    }
  },
);

test(
  "cancelling a response closes the upstream stream without buffering its remainder",
  { timeout: 5000 },
  async () => {
    let closed = () => {};

    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });

    const fixture = await backend((_request, response) => {
      response.once("close", () => closed());
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(new Uint8Array([7, 8, 9]));
    });

    try {
      const response = await createNodeBackendProxy({ origin, backendUrl: fixture.url })(
        new Request(`${origin}/api/storage/files/file1`),
      );

      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.deepEqual([...first.value!], [7, 8, 9]);
      await reader.cancel();
      await disconnected;
    } finally {
      fixture.close();
    }
  },
);

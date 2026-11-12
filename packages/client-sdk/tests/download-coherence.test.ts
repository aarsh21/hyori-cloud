import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";

const descriptor = {
  url: "/api/storage/files/file_1?revision=1",
  name: "report.txt",
  size: 3,
  mimeType: "text/plain",
};

test("downloads forward the server revision condition and preserve a declared conflict", async () => {
  const urls: string[] = [];

  const client = createClient({
    fetch: async (url, init) => {
      urls.push(String(url));

      return init?.method === "POST"
        ? Response.json({ ok: true, value: descriptor })
        : Response.json(
            { ok: false, error: { code: "resource.conflict", message: "Source changed" } },
            { status: 409 },
          );
    },
  });

  try {
    await expect(client.downloads.open({ id: "file_1" })).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect(urls).toEqual(["/api/rpc", descriptor.url]);
  } finally {
    client.dispose();
  }
});

test("a successful download exposes matching metadata and streams without full-file buffering", async () => {
  const client = createClient({
    fetch: async (_url, init) =>
      init?.method === "POST"
        ? Response.json({ ok: true, value: descriptor })
        : new Response("abc", { headers: { "content-length": "3" } }),
  });

  try {
    const download = await client.downloads.open({ id: "file_1" });
    expect(download.metadata).toEqual(descriptor);
    expect(await new Response(download.stream).text()).toBe("abc");
  } finally {
    client.dispose();
  }
});

test("incoherent content length is rejected and its body is cancelled before reaching a sink", async () => {
  let cancelled = 0;

  const client = createClient({
    fetch: async (_url, init) =>
      init?.method === "POST"
        ? Response.json({ ok: true, value: descriptor })
        : new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled += 1;
              },
            }),
            { headers: { "content-length": "5" } },
          ),
  });

  try {
    await expect(client.downloads.open({ id: "file_1" })).rejects.toMatchObject({
      code: "SDK_PROTOCOL",
    });
    expect(cancelled).toBe(1);
  } finally {
    client.dispose();
  }
});

test("a plain gateway outage remains a download transport failure", async () => {
  const client = createClient({
    fetch: async (_url, init) =>
      init?.method === "POST"
        ? Response.json({ ok: true, value: descriptor })
        : new Response("Gateway unavailable", { status: 503 }),
  });

  try {
    await expect(client.downloads.open({ id: "file_1" })).rejects.toMatchObject({
      code: "SDK_TRANSPORT",
    });
  } finally {
    client.dispose();
  }
});

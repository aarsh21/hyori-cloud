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

test("folder downloads accept an unknown length and surface the server's archive limit", async () => {
  const folder = {
    url: "/api/storage/folders/folder_1",
    name: "Trips.zip",
    mimeType: "application/zip",
  };

  let tooLarge = false;

  const client = createClient({
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          operation: "files.downloadFolder",
          input: { id: "folder_1" },
        });

        return Response.json({ ok: true, value: folder });
      }

      expect(String(url)).toBe(folder.url);

      return tooLarge
        ? Response.json(
            {
              ok: false,
              error: { code: "downloads.archiveTooLarge", message: "Limit: 10000 entries" },
            },
            { status: 422 },
          )
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Uint8Array.of(80, 75));
                controller.close();
              },
            }),
          );
    },
  });

  try {
    const { metadata, stream } = await client.downloads.openFolder({ id: "folder_1" });
    expect(metadata).toEqual(folder);
    expect(await new Response(stream).text()).toBe("PK");
    tooLarge = true;
    await expect(client.downloads.openFolder({ id: "folder_1" })).rejects.toEqual({
      code: "downloads.archiveTooLarge",
      message: "Limit: 10000 entries",
    });
  } finally {
    client.dispose();
  }
});

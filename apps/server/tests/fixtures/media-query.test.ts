import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type { OutputOf } from "@hyori-cloud/client-sdk";
import { createQuery } from "@hyori-cloud/client-sdk/react";
import type { Query } from "@hyori-cloud/client-sdk/react";

test("media Query uses the Rust discriminated result and performs no request until executed", async () => {
  const calls: string[] = [];

  const sdk = createClient({
    baseUrl: "https://fixture.invalid/api/rpc",
    fetch: async (_url, init) => {
      calls.push(String(init?.body));

      return Response.json({
        ok: true,
        value: {
          status: "ready",
          kind: "poster",
          sourceRevision: 3,
          url: "/api/storage/derivatives/file/artifact?revision=3",
          width: 256,
          height: 128,
        },
      });
    },
  });

  const query = createQuery(sdk);
  const options = query.media.get.getOptions({ id: "file" });
  expect(calls).toHaveLength(0);
  const result = await options.queryFn({ signal: new AbortController().signal });

  if (result.status !== "ready") throw new Error("Expected fixture ready state");
  expect(result.url).toContain("/derivatives/");
  expect(result.width).toBe(256);
  expect(calls[0]).toContain('"operation":"media.get"');
  sdk.dispose();
});

test("new contracts still decode an older Photos item without derivative metadata", async () => {
  const sdk = createClient({
    baseUrl: "https://fixture.invalid/api/rpc",
    fetch: async () =>
      Response.json({
        ok: true,
        value: {
          items: [
            {
              id: "file",
              name: "photo.png",
              ownerId: "owner",
              parentId: null,
              kind: "file",
              size: 101,
              mimeType: "image/png",
              createdAt: "2026-11-05T00:00:00Z",
              updatedAt: "2026-11-05T00:00:00Z",
              trashedAt: null,
              access: {
                role: null,
                isOwner: true,
                canDownload: true,
                canUpload: false,
                canEdit: true,
                canDelete: true,
                canShare: true,
              },
              previewUrl: "/api/storage/previews/file?revision=0",
            },
          ],
          nextCursor: null,
          folder: null,
          breadcrumbs: [],
        },
      }),
  });

  const result = await sdk.rpc.photos.timeline({});
  expect(result.items[0]?.derivative).toBeUndefined();
  expect(result.items[0]?.previewUrl).toContain("/previews/");
  sdk.dispose();
});

export function compileMediaConsumer(query: Query, result: OutputOf<Query["media"]["get"]>) {
  // @ts-expect-error Commands never appear in the safe query namespace.
  void query.media.retry;

  // @ts-expect-error Ready cannot omit its durable URL and dimensions.
  const incomplete: OutputOf<Query["media"]["get"]> = {
    status: "ready",
    kind: "thumbnail",
    sourceRevision: 0,
  };

  void incomplete;

  switch (result.status) {
    case "ready":
      return result.url;
    case "failed":
      return result.canRetry;
    case "unsupported":
      return result.failure;
    case "queued":
    case "processing":
    case "unavailable":
      return result.sourceRevision;
    default:
      return result satisfies never;
  }
}

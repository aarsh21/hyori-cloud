import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type { InputOf, OutputOf } from "@hyori-cloud/client-sdk";
import { createQuery } from "@hyori-cloud/client-sdk/react";
import type { ResourceOf } from "@hyori-cloud/client-sdk/react";

test("Rust files.get/preview and Photos derive public Query types and execute without a method mirror", async () => {
  const calls: string[] = [];

  const sdk = createClient({
    baseUrl: "https://fixture.invalid/api/rpc",
    fetch: async (_url, init) => {
      calls.push(String(init?.body));

      return Response.json({
        ok: true,
        value: {
          url: "/api/storage/previews/photo",
          name: "photo.png",
          size: 101,
          mimeType: "image/png",
        },
      });
    },
  });

  const query = createQuery(sdk);
  const input: InputOf<typeof query.files.preview> = { id: "photo" };

  const metadata: OutputOf<typeof query.files.preview> = await query.files.preview
    .getOptions(input)
    .queryFn({ signal: new AbortController().signal });

  const resourceData: ResourceOf<typeof query.files.preview>["data"] = metadata;
  expect(resourceData?.mimeType).toBe("image/png");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('"operation":"files.preview"');
  expect(query.files.get.getOptions({ id: "photo" }).queryKey).toEqual(
    query.files.get.getKey({ id: "photo" }),
  );
  expect(query.photos.timeline.getOptions({ albumId: "album" }).queryKey).toEqual(
    query.photos.timeline.getKey({ albumId: "album" }),
  );
  expect(calls).toHaveLength(1);
  sdk.dispose();
});

// Compile-only negative cases ensure the mechanically derived boundary retains exact inputs/results.
export function invalidConsumers(query: ReturnType<typeof createQuery>) {
  // @ts-expect-error IDs remain strings.
  query.files.get.getOptions({ id: 42 });
  // @ts-expect-error Preview metadata never contains private object keys.
  const privateObject: OutputOf<typeof query.files.preview> = { objectKey: "secret" };
  // @ts-expect-error setSources is not a safe query.
  void query.photos.setSources;

  return privateObject;
}

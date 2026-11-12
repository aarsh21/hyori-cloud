import { expect, test } from "bun:test";
import { operations } from "@hyori-cloud/api/rpc";
import { createClient, type Client } from "@hyori-cloud/client-sdk";
import { setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { MutationObserver, QueryClient, QueryObserver } from "@hyori-cloud/lib/query-core";
import { Schema } from "@hyori-cloud/lib/effect";
import { entry } from "#client-sdk-test/fake-api";
import type { OperationDeclaration } from "#client-sdk/inference";

const requestOperation = Schema.decodeUnknownSync(Schema.Struct({ operation: Schema.String }));

test("current-media authorization transitions declare dependent cache invalidation in Rust", () => {
  const declarations: readonly OperationDeclaration[] = operations;

  for (const tag of [
    "files.move",
    "files.trash",
    "files.restore",
    "shares.create",
    "shares.revoke",
    "shares.resolve",
    "shares.unlock",
    "admin.deleteUser",
  ]) {
    const declaration = declarations.find((operation) => operation.rpc._tag === tag);
    expect(declaration?.invalidates).toContain("media");
  }
});

const transitions: readonly {
  name: string;
  complete(client: Client, cache: QueryClient): Promise<void>;
}[] = [
  {
    name: "uploads.complete",
    async complete(client, cache) {
      await new MutationObserver(cache, client.mutation.uploads.complete.mutationOptions()).mutate({
        uploadId: "upload_fake",
      });
    },
  },
  {
    name: "files.restoreVersion",
    async complete(client, cache) {
      await new MutationObserver(
        cache,
        client.mutation.files.restoreVersion.mutationOptions(),
      ).mutate({ id: entry.id, versionId: "version_fake" });
    },
  },
  {
    name: "editors.completeSave",
    async complete(client, cache) {
      await new MutationObserver(
        cache,
        client.mutation.editors.completeSave.mutationOptions(),
      ).mutate({ sessionId: "a".repeat(64), saveId: "save1" });
    },
  },
];

for (const transition of transitions) {
  test(`active media.get observes the new source after ${transition.name}`, async () => {
    let revision = 1;
    let reads = 0;

    const client = createClient({
      fetch: async (_url, init) => {
        const { operation } = requestOperation(await new Response(init?.body).json());

        if (operation === "media.get") {
          reads += 1;

          return Response.json({
            ok: true,
            value: {
              status: "ready",
              kind: "thumbnail",
              sourceRevision: revision,
              url: `/derivatives/${entry.id}?revision=${revision}`,
              width: 120,
              height: 120,
            },
          });
        }

        if (operation !== transition.name)
          throw new Error(`Unexpected cache fixture operation: ${operation}`);
        revision += 1;

        return Response.json({
          ok: true,
          value:
            operation === "editors.completeSave"
              ? { status: "saved", revision: String(revision), file: entry }
              : entry,
        });
      },
    });

    const cache = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });

    setMutationDefaults(cache);
    const options = client.query.media.get.getOptions({ id: entry.id });
    await cache.fetchQuery(options);
    const observer = new QueryObserver(cache, options);
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(1);
      await transition.complete(client, cache);
      expect(reads).toBe(2);
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(2);
      expect(observer.getCurrentResult().data).toMatchObject({
        status: "ready",
        url: `/derivatives/${entry.id}?revision=2`,
      });
    } finally {
      unsubscribe();
      observer.destroy();
      cache.clear();
      client.dispose();
    }
  });
}

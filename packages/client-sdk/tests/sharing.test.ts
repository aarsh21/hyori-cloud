import { expect, test } from "bun:test";
import { createClient, type Share, type UserIdentity } from "@hyori-cloud/client-sdk";
import { setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { Schema } from "@hyori-cloud/lib/effect";
import { MutationObserver, QueryClient } from "@hyori-cloud/lib/query-core";
import { entry, user } from "#client-sdk-test/fake-api";

test("generated sharing operations resolve minimal identity and invalidate their own query scopes", async () => {
  const identity: UserIdentity = { id: user.id, name: user.name, email: user.email };

  const share: Share = {
    id: "share_1",
    itemId: entry.id,
    role: "editor",
    recipient: identity,
    recipientId: identity.id,
    public: false,
    expiresAt: null,
    passwordProtected: false,
    revokedAt: null,
    url: null,
  };

  const readCall = Schema.decodeUnknownSync(
    Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
  );

  const client = createClient({
    fetch: async (_url, init) => {
      const { operation, input } = readCall(await new Response(init?.body).json());

      switch (operation) {
        case "users.search":
          expect(input).toEqual({ query: "Per" });

          return Response.json({ ok: true, value: { items: [identity] } });
        case "shares.update":
          expect(input).toEqual({ id: share.id, role: "editor" });

          return Response.json({ ok: true, value: share });
        case "admin.deleteUser":
          return Response.json({
            ok: true,
            value: { userId: identity.id, state: "pending", deletedObjects: 0 },
          });
        default:
          throw new Error(`Unexpected operation: ${operation}`);
      }
    },
  });

  const cache = new QueryClient();
  setMutationDefaults(cache);

  try {
    const directory = client.query.users.search.getOptions({ query: "Per" });
    expect(await cache.fetchQuery(directory)).toEqual({ items: [identity] });

    const shares = client.query.shares.list.getKey({ itemId: entry.id });
    const file = client.query.files.get.getKey({ id: entry.id });
    const photos = client.query.photos.sources.getKey({});
    const media = client.query.media.get.getKey({ id: entry.id });

    cache.setQueryData(shares, { items: [{ ...share, role: "viewer" }] });
    cache.setQueryData(file, entry);
    cache.setQueryData(photos, { allMyFiles: false, folderIds: [] });
    cache.setQueryData(media, { status: "queued", kind: "thumbnail", sourceRevision: 1 });

    const update = new MutationObserver(cache, client.mutation.shares.update.mutationOptions());
    expect(await update.mutate({ id: share.id, role: "editor" })).toEqual(share);

    for (const key of [shares, file, photos, media]) {
      expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
    }

    expect(cache.getQueryState(directory.queryKey)?.isInvalidated).toBe(false);
    await new MutationObserver(cache, client.mutation.admin.deleteUser.mutationOptions()).mutate({
      userId: identity.id,
      confirmEmail: identity.email,
    });
    expect(cache.getQueryState(directory.queryKey)?.isInvalidated).toBe(true);
  } finally {
    cache.clear();
    client.dispose();
  }
});

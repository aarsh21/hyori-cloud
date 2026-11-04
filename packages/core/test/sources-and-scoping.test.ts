import { expect, test } from "bun:test";
import { FilesDb } from "#core/features/files/db";
import { PhotosService } from "#core/features/photos/service";
import { Transaction } from "@hyori-cloud/lib/surreal";
import {
  account,
  context,
  folder,
  identityRows,
  ReviewDatabase,
  share,
} from "#core-test/review-fixture";

test("unavailable Photos sources are omitted on read and do not block a later source update", async () => {
  const database = new ReviewDatabase((query, variables) => {
    const identity = identityRows(variables);

    if (identity) return identity;

    if (variables.table === "hc_sources")
      return [{ key: account.key, allMyFiles: false, folderIds: [folder.key, "unavailable"] }];

    if (query.includes("FROM hc_share")) return [share];

    if (query.includes("FROM hc_item")) {
      expect(query).toContain("kind = 'folder' AND trashedAt = NULL");
      expect(query).toContain("status = 'active'");
      expect(query).toContain("ownerId = $user OR key IN $roots");

      return [folder];
    }

    throw new Error(`Unexpected source read: ${query}`);
  });

  const ctx = context(database);

  try {
    const service = new PhotosService(ctx);
    expect(await service.sources()).toEqual({ allMyFiles: false, folderIds: [folder.key] });
    expect(
      await service.setSources({ allMyFiles: true, folderIds: [folder.key, "unavailable"] }),
    ).toEqual({ allMyFiles: true, folderIds: [folder.key] });
    expect(database.writes).toHaveLength(1);
    expect(database.writes[0]?.v0).toEqual({
      key: account.key,
      allMyFiles: true,
      folderIds: [folder.key],
    });
  } finally {
    ctx.runtime.storage.close();
  }
});

test("folder searches preserve destination scope and shared searches exclude owned items", async () => {
  const database = new ReviewDatabase((query, variables) => {
    expect(query).toContain("string::contains(string::lowercase(name), $search)");

    if (variables.parent) expect(query).toContain("parentId = $parent");
    else expect(query).toContain("ownerId != $userId");

    return [];
  });

  const transaction = new Transaction(database);
  await FilesDb.list(
    transaction,
    { parentId: folder.key, search: "picture" },
    {
      userId: account.key,
      rootIds: [folder.key],
    },
  );
  await FilesDb.list(
    transaction,
    { view: "shared", search: "picture" },
    {
      userId: account.key,
      rootIds: [folder.key],
    },
  );
});

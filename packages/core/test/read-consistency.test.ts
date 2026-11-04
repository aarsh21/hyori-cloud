import { expect, test } from "bun:test";
import { transact, WriteConflict } from "@hyori-cloud/lib/surreal";
import { FilesService } from "#core/features/files/service";
import { PhotosService } from "#core/features/photos/service";
import { context, folder, identityRows, ReviewDatabase, share } from "#core-test/review-fixture";

for (const journey of ["files", "photos"] as const) {
  test(`${journey} retries authorization if a share is revoked before new private metadata is read`, async () => {
    let revoked = false;
    let scopeReads = 0;
    let privateReads = 0;

    const database = new ReviewDatabase((query, variables) => {
      const identity = identityRows(variables);

      if (identity) return identity;

      if (query.includes("FROM hc_share")) {
        scopeReads += 1;

        return revoked ? [] : [share];
      }

      if (variables.table === "hc_sources")
        return [{ key: "reader", allMyFiles: false, folderIds: [folder.key] }];

      if (query.includes("FROM hc_item")) {
        if (!revoked) {
          // Revoke then create, precisely between scope and data reads.
          revoked = true;
          database.revision += 2;
        }

        if (Array.isArray(variables.roots) && variables.roots.includes(folder.key)) {
          privateReads += 1;

          return [
            {
              ...folder,
              key: "new-private-photo",
              kind: "file",
              parentId: folder.key,
              ancestorIds: [folder.key],
              name: "created-after-revocation.jpg",
              mimeType: "image/jpeg",
              objectKey: "private/new-photo",
            },
          ];
        }

        return [];
      }

      throw new Error(`Unexpected fixture read: ${query}`);
    });

    const ctx = context(database);

    try {
      const result =
        journey === "files"
          ? await new FilesService(ctx).list({ parentId: null, search: "private" })
          : await new PhotosService(ctx).timeline({});

      expect(privateReads).toBe(1);
      expect(scopeReads).toBe(2);
      expect(result.items).toEqual([]);
      expect(database.writes).toEqual([]);
      expect(database.revision).toBe(2);
    } finally {
      ctx.runtime.storage.close();
    }
  });
}

test("read conflicts exhaust a bounded retry budget without issuing mutations", async () => {
  const database = new ReviewDatabase(() => []);
  let attempts = 0;

  await expect(
    transact(database, async () => {
      attempts += 1;
      database.revision += 1;

      return "inconsistent data";
    }),
  ).rejects.toBeInstanceOf(WriteConflict);
  expect(attempts).toBe(6);
  expect(database.writes).toEqual([]);
});

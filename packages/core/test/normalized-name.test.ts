import { expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { Name } from "#core/features/auth/api/schema";
import { FilesService } from "#core/features/files/service";
import { validateName } from "#core/features/files/policy";
import { PhotosService } from "#core/features/photos/service";
import { UploadsService } from "#core/features/uploads/service";
import { context, folder, identityRows, ReviewDatabase, share } from "#core-test/review-fixture";

const expandingName = "̈́".repeat(128);

test("normalization is validated against the authoritative Name codec", () => {
  expect(Schema.is(Name)(expandingName)).toBe(true);
  expect(expandingName.normalize("NFC").length).toBe(256);
  expect(() => validateName(expandingName)).toThrow();
  expect(validateName(" Photos ")).toBe("Photos");
  expect(validateName("📷.jpg")).toBe("📷.jpg");
});

for (const [label, name] of [
  ["expanding NFC", expandingName],
  ["lone high surrogate", "\uD800"],
  ["lone low surrogate", "\uDC00"],
] as const) {
  for (const operation of ["folder", "rename", "upload", "album"] as const) {
    test(`${operation} rejects ${label} names without a persisted mutation`, async () => {
      const database = new ReviewDatabase((query, variables) => {
        const identity = identityRows(variables);

        if (identity) return identity;

        if (variables.table === "hc_item") return [folder];

        if (query.includes("FROM hc_album")) return [];

        if (query.includes("FROM hc_share"))
          return [{ ...share, role: operation === "rename" ? "editor" : "contributor" }];

        throw new Error(`Unexpected fixture read before name validation: ${query}`);
      });

      const ctx = context(database);

      try {
        const actions = {
          folder: () => new FilesService(ctx).createFolder({ parentId: folder.key, name }),
          rename: () => new FilesService(ctx).rename({ id: folder.key, name }),
          upload: () =>
            new UploadsService(ctx).begin({
              parentId: folder.key,
              name,
              size: 0,
              mimeType: "text/plain",
            }),
          album: () => new PhotosService(ctx).createAlbum({ name }),
        };

        await expect(actions[operation]()).rejects.toMatchObject({ code: "input.invalid" });
        expect(database.writes).toEqual([]);
        expect(database.revision).toBe(0);
      } finally {
        ctx.runtime.storage.close();
      }
    });
  }
}

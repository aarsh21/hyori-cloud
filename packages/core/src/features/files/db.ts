import { Schema } from "@hyori-cloud/lib/effect";
import { Stored, type Transaction } from "@hyori-cloud/lib/surreal";
import { Id } from "#core/features/auth/api/schema";
import { FileEntry, FileVersion, type ListFiles } from "#core/features/files/api/schema";

export const ItemRecord = Schema.Struct({
  ...FileEntry.omit("id", "access").fields,
  ...Stored.fields,
  ancestorIds: Schema.Array(Id),
  objectKey: Schema.NullOr(Schema.String),
  uploadedBy: Schema.NullOr(Id),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  trashRoot: Schema.NullOr(Id),
});

export type ItemRecord = typeof ItemRecord.Type;

export const VersionRecord = Schema.Struct({
  ...FileVersion.omit("id").fields,
  ...Stored.fields,
  ownerId: Id,
  objectKey: Schema.String,
  mimeType: FileEntry.fields.mimeType,
});

export type VersionRecord = typeof VersionRecord.Type;

type ListVariables = {
  userId: string | null;
  roots: readonly string[];
  cursor: string;
  parent?: typeof ListFiles.Type.parentId;
  search?: typeof ListFiles.Type.search;
  type?: typeof ListFiles.Type.type;
  typePrefix?: string;
  after?: string;
  before?: string;
  min?: typeof ListFiles.Type.minSize;
  max?: typeof ListFiles.Type.maxSize;
};

export class FilesDb {
  static async list(
    transaction: Transaction,
    input: typeof ListFiles.Type,
    scope: { userId: string | null; rootIds: string[] },
  ) {
    const predicates = [
      "(ownerId = $userId OR key IN $roots OR array::intersect(ancestorIds, $roots) != [])",
      "ownerId IN (SELECT VALUE key FROM hc_user WHERE status = 'active')",
      "key > $cursor",
    ];

    const variables: ListVariables = {
      userId: scope.userId,
      roots: scope.rootIds,
      cursor: input.cursor ?? "",
    };

    if (input.view === "trash") {
      predicates.push("ownerId = $userId", "trashedAt != NULL", "trashRoot = key");
    } else predicates.push("trashedAt = NULL");

    if (input.view === "shared") predicates.push("ownerId != $userId");

    if (input.view === "shared" && input.parentId == null && !input.search)
      predicates.push("key IN $roots");
    else if (input.view !== "trash" && (input.parentId != null || !input.search)) {
      predicates.push("parentId = $parent");
      variables.parent = input.parentId ?? null;
    }

    if (input.search) {
      predicates.push("string::contains(string::lowercase(name), $search)");
      variables.search = input.search.toLowerCase();
    }

    if (input.type) {
      predicates.push(
        "(mimeType = $type OR kind = $type OR string::starts_with(mimeType, $typePrefix))",
      );
      variables.type = input.type;
      variables.typePrefix = `${input.type}/`;
    }

    if (input.after) {
      predicates.push("updatedAt >= $after");
      variables.after = new Date(input.after).toISOString();
    }

    if (input.before) {
      predicates.push("updatedAt <= $before");
      variables.before = new Date(input.before).toISOString();
    }

    if (input.minSize !== undefined) {
      predicates.push("size >= $min");
      variables.min = input.minSize;
    }

    if (input.maxSize !== undefined) {
      predicates.push("size <= $max");
      variables.max = input.maxSize;
    }

    return transaction.find(
      ItemRecord,
      "item",
      predicates.join(" AND "),
      variables,
      (input.limit ?? 100) + 1,
    );
  }
}

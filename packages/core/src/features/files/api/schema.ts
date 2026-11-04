import { Schema } from "@hyori-cloud/lib/effect";
import { Bytes, Id, Name, Timestamp } from "#core/features/auth/api/schema";

export const ShareRole = Schema.Literal("viewer", "contributor", "editor");

export type ShareRole = typeof ShareRole.Type;

export const Access = Schema.Struct({
  role: Schema.NullOr(ShareRole),
  isOwner: Schema.Boolean,
  canDownload: Schema.Boolean,
  canUpload: Schema.Boolean,
  canEdit: Schema.Boolean,
  canDelete: Schema.Boolean,
  canShare: Schema.Boolean,
});

export const FileEntry = Schema.Struct({
  id: Id,
  name: Name,
  kind: Schema.Literal("file", "folder"),
  parentId: Schema.NullOr(Id),
  ownerId: Id,
  size: Bytes,
  mimeType: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  trashedAt: Schema.NullOr(Schema.String),
  access: Access,
});

export type FileEntry = typeof FileEntry.Type;

export const ItemInput = Schema.Struct({ id: Id });

export const ListFiles = Schema.Struct({
  parentId: Schema.optional(Schema.NullOr(Id)),
  view: Schema.optional(Schema.Literal("files", "shared", "trash")),
  search: Schema.optional(Schema.String.pipe(Schema.maxLength(255))),
  type: Schema.optional(Schema.String.pipe(Schema.maxLength(128))),
  after: Schema.optional(Timestamp),
  before: Schema.optional(Timestamp),
  minSize: Schema.optional(Bytes),
  maxSize: Schema.optional(Bytes),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 100))),
});

export const FileList = Schema.Struct({
  items: Schema.Array(FileEntry),
  breadcrumbs: Schema.Array(Schema.Struct({ id: Id, name: Name })),
  nextCursor: Schema.NullOr(Schema.String),
  folder: Schema.NullOr(FileEntry),
});

export const CreateFolder = Schema.Struct({ parentId: Schema.NullOr(Id), name: Name });
export const RenameFile = Schema.Struct({ id: Id, name: Name });
export const MoveFile = Schema.Struct({ id: Id, parentId: Schema.NullOr(Id) });

export const FileVersion = Schema.Struct({
  id: Id,
  fileId: Id,
  size: Bytes,
  createdAt: Schema.String,
});

export const Versions = Schema.Struct({
  items: Schema.Array(FileVersion),
  nextCursor: Schema.NullOr(Schema.String),
});

export const ListVersions = Schema.Struct({
  id: Id,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

export const RestoreVersion = Schema.Struct({ id: Id, versionId: Id });
export const DownloadInput = Schema.Struct({ id: Id, versionId: Schema.optional(Id) });

export const Download = Schema.Struct({
  url: Schema.String,
  name: Name,
  size: Bytes,
  mimeType: Schema.String,
});

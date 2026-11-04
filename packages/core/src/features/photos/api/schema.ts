import { Schema } from "@hyori-cloud/lib/effect";
import { Id, Name } from "#core/features/auth/api/schema";
import { FileEntry, FileList } from "#core/features/files/api/schema";

export const PhotoSources = Schema.Struct({
  allMyFiles: Schema.Boolean,
  folderIds: Schema.Array(Id).pipe(Schema.maxItems(100)),
});

export const TimelineInput = Schema.Struct({
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  albumId: Schema.optional(Id),
});

export const Timeline = Schema.Struct({
  ...FileList.fields,
  items: Schema.Array(Schema.Struct({ ...FileEntry.fields, previewUrl: Schema.String })),
});

export const Album = Schema.Struct({
  id: Id,
  name: Name,
  createdAt: Schema.String,
  count: Schema.Number,
});

export type Album = typeof Album.Type;

export const Albums = Schema.Struct({ items: Schema.Array(Album) });
export const CreateAlbum = Schema.Struct({ name: Name });

export const AddToAlbum = Schema.Struct({
  albumId: Id,
  fileIds: Schema.Array(Id).pipe(Schema.maxItems(100)),
});

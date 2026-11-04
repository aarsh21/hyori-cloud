import { Schema } from "@hyori-cloud/lib/effect";
import { Stored } from "@hyori-cloud/lib/surreal";
import { Id } from "#core/features/auth/api/schema";
import { Album, PhotoSources } from "#core/features/photos/api/schema";

export const SourcesRecord = Schema.Struct({ ...Stored.fields, ...PhotoSources.fields });

export type SourcesRecord = typeof SourcesRecord.Type;

export const AlbumRecord = Schema.Struct({
  ...Stored.fields,
  ...Album.omit("id").fields,
  ownerId: Id,
});

export type AlbumRecord = typeof AlbumRecord.Type;

export const AlbumItemRecord = Schema.Struct({
  ...Stored.fields,
  albumId: Id,
  fileId: Id,
  ownerId: Id,
});

export type AlbumItemRecord = typeof AlbumItemRecord.Type;

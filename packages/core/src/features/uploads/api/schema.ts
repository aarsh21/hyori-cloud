import { Schema } from "@hyori-cloud/lib/effect";
import { Bytes, Id, Name } from "#core/features/auth/api/schema";

export const BeginUpload = Schema.Struct({
  parentId: Schema.NullOr(Id),
  name: Name,
  size: Bytes,
  mimeType: Schema.String.pipe(Schema.maxLength(128)),
  replaceId: Schema.optional(Id),
});

export const UploadInput = Schema.Struct({ uploadId: Id });

export const UploadPartInput = Schema.Struct({
  uploadId: Id,
  partNumber: Schema.Number.pipe(Schema.int(), Schema.between(1, 10000)),
});

export const UploadStatus = Schema.Struct({
  uploadId: Id,
  chunkSize: Bytes,
  totalParts: Bytes,
  parts: Schema.Array(Schema.Struct({ partNumber: Schema.Number, size: Bytes })),
  state: Schema.Literal("uploading", "complete", "aborted"),
  fileId: Schema.NullOr(Id),
});

export type UploadStatus = typeof UploadStatus.Type;

export const UploadPart = Schema.Struct({
  url: Schema.String,
  method: Schema.Literal("PUT"),
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

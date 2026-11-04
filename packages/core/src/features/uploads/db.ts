import { Schema } from "@hyori-cloud/lib/effect";
import { Stored } from "@hyori-cloud/lib/surreal";
import { Bytes, Id, Timestamp } from "#core/features/auth/api/schema";
import { BeginUpload, UploadPartInput } from "#core/features/uploads/api/schema";

export const CHUNK_SIZE = 8 * 1024 * 1024;

export const UploadRecord = Schema.Struct({
  ...Stored.fields,
  ...BeginUpload.omit("replaceId").fields,
  ownerId: Id,
  initiator: Schema.String,
  uploaderId: Schema.NullOr(Id),
  objectKey: Schema.String,
  multipartId: Schema.NullOr(Schema.String),
  replaceId: Schema.NullOr(Id),
  replaceRevision: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  state: Schema.Literal("starting", "uploading", "finalizing", "complete", "aborted"),
  parts: Schema.Array(
    Schema.Struct({
      partNumber: UploadPartInput.fields.partNumber,
      size: Bytes,
      etag: Schema.String,
    }),
  ),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  fileId: Schema.NullOr(Id),
  cleanupPending: Schema.Boolean,
});

export type UploadRecord = typeof UploadRecord.Type;

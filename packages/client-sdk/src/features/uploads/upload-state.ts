import { Bytes, FileEntry } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";
import { ClientError } from "#client-sdk/errors";
import { UploadCheckpoint } from "#client-sdk/features/uploads/upload-checkpoint";

const progress = {
  uploadedBytes: Bytes,
  totalBytes: Bytes,
  checkpoint: Schema.NullOr(UploadCheckpoint),
};

/** The SDK owns this local workflow. Backend file/error/checkpoint fields retain their runtime owners. */
export const UploadSnapshot = Schema.Union(
  Schema.Struct({
    ...progress,
    status: Schema.Literal("pending", "uploading", "finalizing", "cancelling"),
    error: Schema.Null,
    file: Schema.Null,
  }),
  Schema.Struct({
    ...progress,
    status: Schema.Literal("paused", "cancelled"),
    error: Schema.NullOr(ClientError),
    file: Schema.Null,
  }),
  Schema.Struct({
    ...progress,
    status: Schema.Literal("failed"),
    intent: Schema.optional(Schema.Literal("upload", "cancel")),
    error: ClientError,
    file: Schema.Null,
  }),
  Schema.Struct({
    ...progress,
    checkpoint: UploadCheckpoint,
    status: Schema.Literal("complete"),
    error: Schema.Null,
    file: FileEntry,
  }),
);

export type UploadSnapshot = typeof UploadSnapshot.Type;

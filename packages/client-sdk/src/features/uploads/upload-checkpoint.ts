import { Bytes, Id } from "@hyori-cloud/api/client";
import { Schema } from "@hyori-cloud/lib/effect";
import { UploadIntent } from "#client-sdk/features/uploads/upload-intent";

export const UploadFileFingerprint = Schema.Struct({
  name: Schema.String,
  size: Bytes,
  type: Schema.String,
  lastModified: Schema.Number.pipe(Schema.int(), Schema.finite()),
});

export type UploadFileFingerprint = typeof UploadFileFingerprint.Type;

/** Persist metadata only. Local File handles/bytes are never retained across a reload. */
export const UploadCheckpoint = Schema.Union(
  Schema.Struct({
    version: Schema.Literal(1),
    uploadId: Id,
    file: UploadFileFingerprint,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    uploadId: Id,
    file: UploadFileFingerprint,
    intent: UploadIntent.pipe(Schema.filter((intent) => intent.kind !== "legacy")),
  }),
);

export type UploadCheckpoint = typeof UploadCheckpoint.Type;

export function checkpointIntent(checkpoint: UploadCheckpoint): UploadIntent {
  return checkpoint.version === 1
    ? { kind: "legacy", name: checkpoint.file.name }
    : checkpoint.intent;
}

export function matchesCheckpointFile(
  checkpoint: UploadCheckpoint,
  file: UploadFileFingerprint,
): boolean {
  return (
    checkpoint.file.name === file.name &&
    checkpoint.file.size === file.size &&
    checkpoint.file.type === file.type &&
    checkpoint.file.lastModified === file.lastModified
  );
}

export const decodeUploadCheckpoint = Schema.decodeUnknownSync(UploadCheckpoint, {
  onExcessProperty: "error",
});

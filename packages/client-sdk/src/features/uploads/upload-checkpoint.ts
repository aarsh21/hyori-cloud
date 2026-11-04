import { Bytes, Id } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";

/** Persist metadata only. Local File handles/bytes are never retained across a reload. */
export const UploadCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  uploadId: Id,
  file: Schema.Struct({
    name: Schema.String,
    size: Bytes,
    type: Schema.String,
    lastModified: Schema.Number.pipe(Schema.int()),
  }),
});

export type UploadCheckpoint = typeof UploadCheckpoint.Type;

export function matchesCheckpointFile(
  checkpoint: UploadCheckpoint,
  file: UploadCheckpoint["file"],
): boolean {
  return (
    checkpoint.file.name === file.name &&
    checkpoint.file.size === file.size &&
    checkpoint.file.type === file.type &&
    checkpoint.file.lastModified === file.lastModified
  );
}

export const decodeUploadCheckpoint = Schema.decodeUnknownSync(UploadCheckpoint);

import { ApiError, Bytes, FileEntry, Id, Name } from "@hyori-cloud/api/wire";
import * as z from "@hyori-cloud/lib/json";
import { SDKError } from "#client-sdk/errors";
import type {
  UploadCheckpoint,
  UploadFileFingerprint,
} from "#client-sdk/features/uploads/upload-checkpoint";
import type { UploadIntent } from "#client-sdk/features/uploads/upload-intent";
import type { UploadSnapshot } from "#client-sdk/features/uploads/upload-state";

/** SDK-owned metadata, with the same contracts as the public Effect compatibility schemas. */
const fingerprintFields = {
  name: z.string(),
  size: Bytes,
  type: z.string(),
  lastModified: z.int(),
};

export const fingerprint: z.ZodMiniType<UploadFileFingerprint> = z.object(fingerprintFields);
const newIntent = { kind: z.literal("new"), name: Name };
const replacementIntent = { kind: z.literal("replacement"), name: Name, targetId: Id };

export const intent: z.ZodMiniType<UploadIntent> = z.union([
  z.object(newIntent),
  z.object(replacementIntent),
  z.object({ kind: z.literal("legacy"), name: z.string() }),
]);

const checkpoint: z.ZodMiniType<UploadCheckpoint> = z.union([
  z.object({ version: z.literal(1), uploadId: Id, file: fingerprint }),
  z.object({
    version: z.literal(2),
    uploadId: Id,
    file: fingerprint,
    intent: z.union([z.object(newIntent), z.object(replacementIntent)]),
  }),
]);

const storedCheckpoint: z.ZodMiniType<UploadCheckpoint> = z.union([
  z.strictObject({ version: z.literal(1), uploadId: Id, file: z.strictObject(fingerprintFields) }),
  z.strictObject({
    version: z.literal(2),
    uploadId: Id,
    file: z.strictObject(fingerprintFields),
    intent: z.union([z.strictObject(newIntent), z.strictObject(replacementIntent)]),
  }),
]);

const failure = z.union([ApiError, z.custom<SDKError>((value) => value instanceof SDKError)]);
const progress = { uploadedBytes: Bytes, totalBytes: Bytes, checkpoint: z.nullable(checkpoint) };

export const snapshot: z.ZodMiniType<UploadSnapshot> = z.union([
  z.object({
    ...progress,
    status: z.literal(["pending", "uploading", "finalizing", "cancelling"]),
    error: z.null(),
    file: z.null(),
  }),
  z.object({
    ...progress,
    status: z.literal(["paused", "cancelled"]),
    error: z.nullable(failure),
    file: z.null(),
  }),
  z.object({
    ...progress,
    status: z.literal("failed"),
    intent: z.optional(z.literal(["upload", "cancel"])),
    error: failure,
    file: z.null(),
  }),
  z.object({
    ...progress,
    checkpoint,
    status: z.literal("complete"),
    error: z.null(),
    file: FileEntry,
  }),
]);

export const decodeUploadCheckpoint = storedCheckpoint.parse;

export function checkpointIntent(value: UploadCheckpoint): UploadIntent {
  return value.version === 1 ? { kind: "legacy", name: value.file.name } : value.intent;
}

export function matchesCheckpointFile(
  value: UploadCheckpoint,
  file: UploadFileFingerprint,
): boolean {
  return (
    value.file.name === file.name &&
    value.file.size === file.size &&
    value.file.type === file.type &&
    value.file.lastModified === file.lastModified
  );
}

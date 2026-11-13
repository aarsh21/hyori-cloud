import type { ClientError } from "#client-sdk/errors";
import type { UploadFailure, UploadIntent } from "#client-sdk/features/uploads/upload-intent";

/** Semantic tokens only; hosts never interpret the transfer protocol. */
export function getUploadFailure(intent: UploadIntent, error: ClientError): UploadFailure {
  if (intent.kind === "replacement")
    return error.code === "resource.conflict" ? "replacement-conflict" : "replacement-failed";

  if (intent.kind === "new" && error.code === "resource.conflict") return "upload-conflict";

  return "upload-failed";
}

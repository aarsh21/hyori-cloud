import { Id, Name } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";
import type { ClientError } from "#client-sdk/errors";

/** Local intent is not a grant: the server authorizes and checks replacement revisions. */
export const UploadIntent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("new"), name: Name }),
  Schema.Struct({ kind: Schema.Literal("replacement"), name: Name, targetId: Id }),
  // V1 checkpoints did not record intent. Never guess replacement identity from a filename.
  Schema.Struct({ kind: Schema.Literal("legacy"), name: Schema.String }),
);

export type UploadIntent = typeof UploadIntent.Type;

export const UploadFailure = Schema.Literal(
  "upload-conflict",
  "replacement-conflict",
  "replacement-failed",
  "upload-failed",
);

export type UploadFailure = typeof UploadFailure.Type;

/** Semantic tokens only; hosts supply localized copy without interpreting the transfer protocol. */
export function getUploadFailure(intent: UploadIntent, error: ClientError): UploadFailure {
  if (intent.kind === "replacement")
    return error.code === "resource.conflict" ? "replacement-conflict" : "replacement-failed";

  if (intent.kind === "new" && error.code === "resource.conflict") return "upload-conflict";

  return "upload-failed";
}

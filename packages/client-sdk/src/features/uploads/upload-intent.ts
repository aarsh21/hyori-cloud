import { Id, Name } from "@hyori-cloud/api/client";
import { Schema } from "@hyori-cloud/lib/effect";

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

export { getUploadFailure } from "#client-sdk/features/uploads/upload-failure";

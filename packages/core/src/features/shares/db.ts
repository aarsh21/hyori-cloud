import { Schema } from "@hyori-cloud/lib/effect";
import { Stored } from "@hyori-cloud/lib/surreal";
import { Id, Timestamp } from "#core/features/auth/api/schema";
import { Share } from "#core/features/shares/api/schema";

export const ShareRecord = Schema.Struct({
  ...Share.omit("id", "url", "passwordProtected").fields,
  ...Stored.fields,
  issuerId: Id,
  tokenHash: Schema.NullOr(Schema.String),
  passwordHash: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
});

export type ShareRecord = typeof ShareRecord.Type;

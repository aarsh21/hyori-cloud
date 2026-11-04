import { Schema } from "@hyori-cloud/lib/effect";
import { Stored } from "@hyori-cloud/lib/surreal";
import { Bytes, Id, Timestamp, User } from "#core/features/auth/api/schema";

export const UserRecord = Schema.Struct({
  ...User.omit("id").fields,
  ...Stored.fields,
  passwordHash: Schema.String,
  reservedBytes: Bytes,
  status: Schema.Literal("active", "deleting", "deleted"),
});

export type UserRecord = typeof UserRecord.Type;

export const SessionRecord = Schema.Struct({ ...Stored.fields, userId: Id, expiresAt: Timestamp });

export type SessionRecord = typeof SessionRecord.Type;

export const GrantRecord = Schema.Struct({ ...Stored.fields, shareId: Id, expiresAt: Timestamp });

export type GrantRecord = typeof GrantRecord.Type;

export const InviteRecord = Schema.Struct({
  ...Stored.fields,
  email: Schema.NullOr(Schema.String),
  issuerId: Id,
  expiresAt: Timestamp,
  consumedAt: Schema.NullOr(Timestamp),
});

export type InviteRecord = typeof InviteRecord.Type;

export const RateRecord = Schema.Struct({
  ...Stored.fields,
  attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  resetAt: Timestamp,
});

export type RateRecord = typeof RateRecord.Type;

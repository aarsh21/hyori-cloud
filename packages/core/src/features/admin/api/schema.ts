import { Schema } from "@hyori-cloud/lib/effect";
import { Bytes, Id, NewAccount, Timestamp, User } from "#core/features/auth/api/schema";

export const AdminUser = Schema.Struct({
  ...User.fields,
  status: Schema.Literal("active", "deleting"),
  reservedBytes: Bytes,
});

export const UsersList = Schema.Struct({
  items: Schema.Array(AdminUser),
  nextCursor: Schema.NullOr(Schema.String),
});

export const UsersInput = Schema.Struct({ cursor: Schema.optional(Schema.NullOr(Schema.String)) });

export const CreateUser = Schema.Struct({
  ...NewAccount.fields,
  quotaBytes: Schema.optional(Bytes),
});

export const CreateInvite = Schema.Struct({
  email: Schema.optional(Schema.String.pipe(Schema.maxLength(254))),
  expiresAt: Schema.optional(Timestamp),
});

export const Invite = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
export const SetQuota = Schema.Struct({ userId: Id, quotaBytes: Bytes });
export const DeleteUser = Schema.Struct({ userId: Id, confirmEmail: Schema.String });

export const PurgeResult = Schema.Struct({
  userId: Id,
  state: Schema.Literal("complete", "pending"),
  deletedObjects: Bytes,
});

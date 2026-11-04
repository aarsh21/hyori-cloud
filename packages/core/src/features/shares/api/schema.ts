import { Schema } from "@hyori-cloud/lib/effect";
import { Id, Timestamp } from "#core/features/auth/api/schema";
import { FileEntry, ShareRole } from "#core/features/files/api/schema";

export const Share = Schema.Struct({
  id: Id,
  itemId: Id,
  role: ShareRole,
  recipientId: Schema.NullOr(Id),
  public: Schema.Boolean,
  expiresAt: Schema.NullOr(Schema.String),
  passwordProtected: Schema.Boolean,
  revokedAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});

export type Share = typeof Share.Type;

export const SharesListInput = Schema.Struct({ itemId: Id });
export const SharesList = Schema.Struct({ items: Schema.Array(Share) });

export const CreateShare = Schema.Struct({
  itemId: Id,
  role: ShareRole,
  recipientId: Schema.optional(Schema.NullOr(Id)),
  public: Schema.Boolean,
  password: Schema.optional(Schema.String.pipe(Schema.minLength(8), Schema.maxLength(1024))),
  expiresAt: Schema.optional(Schema.NullOr(Timestamp)),
});

export const ShareInput = Schema.Struct({ id: Id });
export const ResolveShare = Schema.Struct({ token: Schema.String.pipe(Schema.maxLength(256)) });

export const UnlockShare = Schema.Struct({
  token: Schema.String.pipe(Schema.maxLength(256)),
  password: Schema.String.pipe(Schema.maxLength(1024)),
});

export const ResolvedShare = Schema.Struct({
  share: Share,
  item: Schema.NullOr(FileEntry),
  requiresPassword: Schema.Boolean,
});

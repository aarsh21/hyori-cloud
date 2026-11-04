import { Schema } from "@hyori-cloud/lib/effect";

export const Id = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255));
export const Bytes = Schema.Number.pipe(Schema.int(), Schema.between(0, Number.MAX_SAFE_INTEGER));

export const Timestamp = Schema.String.pipe(
  Schema.maxLength(40),
  Schema.filter((value) => Number.isFinite(Date.parse(value)), {
    message: () => "Use a valid ISO date or date-time",
  }),
);

export const Empty = Schema.Struct({});
export const Done = Schema.Struct({ success: Schema.Literal(true) });

export const ApiError = Schema.Struct({
  code: Schema.Literal(
    "auth.required",
    "auth.invalidCredentials",
    "auth.setupDenied",
    "auth.rateLimited",
    "access.denied",
    "input.invalid",
    "resource.notFound",
    "resource.conflict",
    "storage.quotaExceeded",
    "service.unavailable",
  ),
  message: Schema.String,
});

export type ApiError = typeof ApiError.Type;

export const User = Schema.Struct({
  id: Id,
  email: Schema.String,
  name: Name,
  role: Schema.Literal("admin", "user"),
  quotaBytes: Bytes,
  usedBytes: Bytes,
});

export type User = typeof User.Type;

export const AuthStatus = Schema.Struct({ initialized: Schema.Boolean, user: Schema.NullOr(User) });

export const Credentials = Schema.Struct({
  email: Schema.String.pipe(Schema.maxLength(254)),
  password: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
});

export const NewAccount = Schema.Struct({
  email: Schema.String.pipe(Schema.maxLength(254)),
  name: Name,
  password: Schema.String.pipe(Schema.minLength(12), Schema.maxLength(1024)),
});

export const Setup = Schema.Struct({
  ...NewAccount.fields,
  setupToken: Schema.String.pipe(Schema.maxLength(256)),
});

export const AcceptInvite = Schema.Struct({
  ...NewAccount.fields,
  token: Schema.String.pipe(Schema.maxLength(256)),
});

import { Schema } from "@hyori-cloud/lib/effect";
import { digest } from "@hyori-cloud/lib/crypto";
import {
  SurrealDatabase,
  Transaction,
  transact,
  type SurrealConfig,
} from "@hyori-cloud/lib/surreal";
import { ObjectStorage, type StorageConfig } from "@hyori-cloud/lib/storage";
import type { ApiError } from "#core/features/auth/api/schema";
import { GrantRecord, SessionRecord, UserRecord } from "#core/features/auth/db";

export const ServerConfig = Schema.Struct({
  origin: Schema.String,
  setupToken: Schema.String.pipe(Schema.minLength(24)),
  secureCookies: Schema.optional(Schema.Boolean),
  basePath: Schema.optional(Schema.String),
  storagePath: Schema.optional(Schema.String),
  defaultQuotaBytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  surreal: Schema.Struct({
    url: Schema.String,
    namespace: Schema.String,
    database: Schema.String,
    username: Schema.String,
    password: Schema.String,
  }),
  storage: Schema.Struct({
    endpoint: Schema.String,
    region: Schema.String,
    bucket: Schema.String,
    accessKeyId: Schema.String,
    secretAccessKey: Schema.String,
  }),
});

export type ServerConfig = typeof ServerConfig.Type;

export type ResolvedConfig = ServerConfig & {
  secureCookies: boolean;
  basePath: string;
  storagePath: string;
  defaultQuotaBytes: number;
};

export class DomainError extends Error {
  constructor(
    readonly code: ApiError["code"],
    message: string,
  ) {
    super(message);
  }
}

export function fail(code: ApiError["code"], message: string): never {
  throw new DomainError(code, message);
}

export function requireValue<T>(value: T | null | undefined, message = "Item not found"): T {
  if (value == null) fail("resource.notFound", message);

  return value;
}

export const now = () => new Date().toISOString();
export const expires = (milliseconds: number) => new Date(Date.now() + milliseconds).toISOString();
export const active = (expiry: string | null) => expiry === null || Date.parse(expiry) > Date.now();

export function publicUser(user: UserRecord) {
  return {
    id: user.key,
    email: user.email,
    name: user.name,
    role: user.role,
    quotaBytes: user.quotaBytes,
    usedBytes: user.usedBytes,
  };
}

export function requireUser(actor: Actor): UserRecord {
  if (!actor.user) fail("auth.required", "Sign in to continue");

  return actor.user;
}

export function requireAdmin(actor: Actor): UserRecord {
  const user = requireUser(actor);

  if (user.role !== "admin") fail("access.denied", "Administrator access required");

  return user;
}

export type Actor = {
  user: UserRecord | null;
  shareIds: readonly string[];
  sessionHash: string | null;
  grantHashes: readonly string[];
};

export class Runtime {
  readonly database: SurrealDatabase;
  readonly storage: ObjectStorage;
  readonly config: ResolvedConfig;
  private ready: Promise<void> | undefined;
  constructor(
    config: ServerConfig,
    capabilities: { database?: SurrealDatabase; storage?: ObjectStorage } = {},
  ) {
    const value = Schema.decodeUnknownSync(ServerConfig)(config);
    const origin = new URL(value.origin);

    if (
      origin.origin !== value.origin ||
      (!value.secureCookies && origin.protocol !== "http:" && origin.protocol !== "https:")
    )
      throw new Error("origin must be an HTTP(S) origin");

    if (value.secureCookies !== false && origin.protocol !== "https:")
      throw new Error("Production sessions require HTTPS");
    this.config = {
      ...value,
      secureCookies: value.secureCookies ?? true,
      basePath: value.basePath ?? "/api/rpc",
      storagePath: value.storagePath ?? "/api/storage",
      defaultQuotaBytes: value.defaultQuotaBytes ?? 10 * 1024 ** 3,
    };
    this.database =
      capabilities.database ?? new SurrealDatabase(value.surreal satisfies SurrealConfig);
    this.storage = capabilities.storage ?? new ObjectStorage(value.storage satisfies StorageConfig);
  }
  async initialize(): Promise<void> {
    this.ready ??= Promise.all([this.database.initialize(), this.storage.ensureBucket()])
      .then(() => undefined)
      .catch((error) => {
        this.ready = undefined;
        throw error;
      });

    return this.ready;
  }
}

export class RequestContext {
  readonly responseHeaders = new Headers();
  constructor(
    readonly runtime: Runtime,
    readonly request: Request,
  ) {}
  get config() {
    return this.runtime.config;
  }
  private cookie(name: string): string | null {
    const value = this.request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);

    return value && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
  }
  private shareCookies() {
    return (this.request.headers.get("cookie") ?? "")
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(
        ([name, token]) =>
          name &&
          /^hyori_share(?:_[A-Za-z0-9_-]{1,64})?$/.test(name) &&
          token &&
          /^[A-Za-z0-9_-]{1,256}$/.test(token),
      )
      .map(([name, token]) => ({ name: name!, token: token! }));
  }
  clearShareCookies(): void {
    for (const { name } of this.shareCookies()) this.setCookie(name, "", 0);
  }
  setShareCookie(shareId: string, token: string): void {
    const name = `hyori_share_${shareId}`;
    const others = this.shareCookies().filter((cookie) => cookie.name !== name);

    // Keep the per-request authorization work and browser cookie footprint bounded.
    for (const cookie of others.slice(0, Math.max(0, others.length - 15)))
      this.setCookie(cookie.name, "", 0);
    this.setCookie(name, token, 12 * 3600);
  }
  setCookie(name: string, value: string, maxAge: number): void {
    this.responseHeaders.append(
      "Set-Cookie",
      `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.secureCookies ? "; Secure" : ""}`,
    );
  }
  async actor(transaction: Transaction): Promise<Actor> {
    const sessionToken = this.cookie("hyori_session");
    const sessionHash = sessionToken ? digest(sessionToken) : null;

    const grantHashes = [
      ...new Set(
        this.shareCookies()
          .slice(-16)
          .map(({ token }) => digest(token)),
      ),
    ];

    const session = sessionHash
      ? await transaction.get(SessionRecord, "session", sessionHash)
      : null;

    let user =
      session && active(session.expiresAt)
        ? await transaction.get(UserRecord, "user", session.userId)
        : null;

    if (user?.status !== "active") user = null;

    const grants = grantHashes.length
      ? await transaction.find(
          GrantRecord,
          "grant",
          "key IN $keys AND expiresAt > $now",
          { keys: grantHashes, now: now() },
          16,
        )
      : [];

    return {
      user,
      shareIds: [...new Set(grants.map((grant) => grant.shareId))],
      sessionHash,
      grantHashes,
    };
  }
  run<T>(action: (transaction: Transaction, actor: Actor) => Promise<T>): Promise<T> {
    return transact(this.runtime.database, async (transaction) =>
      action(transaction, await this.actor(transaction)),
    );
  }
}

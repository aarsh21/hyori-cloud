import {
  constantEqual,
  digest,
  hashPassword,
  newId,
  randomToken,
  verifyPassword,
} from "@hyori-cloud/lib/crypto";
import type { Transaction } from "@hyori-cloud/lib/surreal";
import type { AcceptInvite, Credentials, NewAccount, Setup } from "#core/features/auth/api/schema";
import { InviteRecord, RateRecord, UserRecord } from "#core/features/auth/db";
import { active, expires, fail, now, publicUser, RequestContext } from "#core/runtime";

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    fail("input.invalid", "Enter a valid email address");

  return normalized;
}

export async function createAccount(
  transaction: Transaction,
  input: typeof NewAccount.Type,
  passwordHash: string,
  role: "admin" | "user",
  quotaBytes: number,
): Promise<UserRecord> {
  const email = normalizeEmail(input.email);

  if ((await transaction.find(UserRecord, "user", "email = $email", { email }, 1)).length)
    fail("resource.conflict", "An account already uses this email");

  const record: UserRecord = {
    key: newId(),
    email,
    name: input.name.trim() || fail("input.invalid", "Name is required"),
    passwordHash,
    role,
    quotaBytes,
    usedBytes: 0,
    reservedBytes: 0,
    status: "active",
  };

  transaction.put("user", record);

  return record;
}

export async function consumeRate(ctx: RequestContext, identifier: string): Promise<void> {
  await ctx.run(async (transaction) => {
    const key = digest(identifier);
    const stored = await transaction.get(RateRecord, "rate", key);

    const record =
      stored && active(stored.resetAt)
        ? stored
        : { key, attempts: 0, resetAt: expires(15 * 60 * 1000) };

    if (record.attempts >= 10)
      fail("auth.rateLimited", "Too many attempts; try again in 15 minutes");
    transaction.put("rate", { ...record, attempts: record.attempts + 1 });
  });
}

export class AuthService {
  constructor(private readonly ctx: RequestContext) {}
  status() {
    return this.ctx.run(async (transaction, actor) => ({
      initialized: (await transaction.control()).initialized,
      user: actor.user ? publicUser(actor.user) : null,
    }));
  }
  async setup(input: typeof Setup.Type) {
    await consumeRate(this.ctx, "setup");

    if (!constantEqual(input.setupToken, this.ctx.config.setupToken))
      fail("auth.setupDenied", "Setup is not authorized");
    const passwordHash = await hashPassword(input.password);
    const token = randomToken();

    const user = await this.ctx.run(async (transaction) => {
      if ((await transaction.control()).initialized)
        fail("auth.setupDenied", "This instance is already initialized");

      const account = await createAccount(
        transaction,
        input,
        passwordHash,
        "admin",
        this.ctx.config.defaultQuotaBytes,
      );

      transaction.setInitialized();
      transaction.put("session", {
        key: digest(token),
        userId: account.key,
        expiresAt: expires(7 * 86400000),
      });

      return publicUser(account);
    });

    this.ctx.setCookie("hyori_session", token, 7 * 86400);

    return user;
  }
  async login(input: typeof Credentials.Type) {
    const email = normalizeEmail(input.email);
    await consumeRate(this.ctx, `login:${email}`);

    const candidate = await this.ctx.run(
      async (transaction) =>
        (await transaction.find(UserRecord, "user", "email = $email", { email }, 1))[0],
    );

    const valid = candidate
      ? await verifyPassword(input.password, candidate.passwordHash)
      : Boolean(await hashPassword(input.password)) && false;

    if (!valid || !candidate || candidate.status !== "active")
      fail("auth.invalidCredentials", "Email or password is incorrect");
    const token = randomToken();

    const user = await this.ctx.run(async (transaction) => {
      const current = await transaction.get(UserRecord, "user", candidate.key);

      if (
        !current ||
        current.status !== "active" ||
        current.passwordHash !== candidate.passwordHash
      )
        fail("auth.invalidCredentials", "Email or password is incorrect");
      transaction.put("session", {
        key: digest(token),
        userId: current.key,
        expiresAt: expires(7 * 86400000),
      });

      return publicUser(current);
    });

    this.ctx.setCookie("hyori_session", token, 7 * 86400);
    this.ctx.clearShareCookies();

    return user;
  }
  async logout() {
    await this.ctx.run(async (transaction, actor) => {
      if (actor.sessionHash) transaction.delete("session", actor.sessionHash);

      for (const hash of actor.grantHashes) transaction.delete("grant", hash);
    });
    this.ctx.setCookie("hyori_session", "", 0);
    this.ctx.clearShareCookies();

    return { success: true as const };
  }
  async acceptInvite(input: typeof AcceptInvite.Type) {
    await consumeRate(this.ctx, `invite:${digest(input.token)}`);
    const passwordHash = await hashPassword(input.password);
    const token = randomToken();

    const user = await this.ctx.run(async (transaction) => {
      const invite = await transaction.get(InviteRecord, "invite", digest(input.token));
      const issuer = invite ? await transaction.get(UserRecord, "user", invite.issuerId) : null;

      if (
        !invite ||
        invite.consumedAt ||
        !active(invite.expiresAt) ||
        issuer?.status !== "active" ||
        issuer.role !== "admin"
      )
        fail("access.denied", "Invitation is invalid or expired");

      if (invite.email && invite.email !== normalizeEmail(input.email))
        fail("access.denied", "This invitation is for a different account");

      const account = await createAccount(
        transaction,
        input,
        passwordHash,
        "user",
        this.ctx.config.defaultQuotaBytes,
      );

      transaction.put("invite", { ...invite, consumedAt: now() });
      transaction.put("session", {
        key: digest(token),
        userId: account.key,
        expiresAt: expires(7 * 86400000),
      });

      return publicUser(account);
    });

    this.ctx.setCookie("hyori_session", token, 7 * 86400);

    return user;
  }
}

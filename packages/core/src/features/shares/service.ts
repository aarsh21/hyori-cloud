import { digest, hashPassword, newId, randomToken, verifyPassword } from "@hyori-cloud/lib/crypto";
import { UserRecord } from "#core/features/auth/db";
import { consumeRate } from "#core/features/auth/service";
import { authorizeItem, projectItem } from "#core/features/files/policy";
import type {
  CreateShare,
  ResolveShare,
  ShareInput,
  SharesListInput,
  UnlockShare,
} from "#core/features/shares/api/schema";
import { ShareRecord } from "#core/features/shares/db";
import { active, expires, fail, now, RequestContext, requireValue } from "#core/runtime";

function projectShare(share: ShareRecord, url: string | null = null) {
  return {
    id: share.key,
    itemId: share.itemId,
    role: share.role,
    recipientId: share.recipientId,
    public: share.public,
    expiresAt: share.expiresAt,
    passwordProtected: share.passwordHash !== null,
    revokedAt: share.revokedAt,
    url,
  };
}

export class SharesService {
  constructor(private readonly ctx: RequestContext) {}
  list(input: typeof SharesListInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      await authorizeItem(transaction, actor, input.itemId, "owner");

      const rows = await transaction.find(
        ShareRecord,
        "share",
        "itemId = $item AND revokedAt = NULL",
        { item: input.itemId },
        100,
      );

      return { items: rows.map((row) => projectShare(row)) };
    });
  }
  async create(input: typeof CreateShare.Type) {
    await this.ctx.run(async (transaction, actor) => {
      await authorizeItem(transaction, actor, input.itemId, "owner");
    });

    if (input.public === Boolean(input.recipientId))
      fail("input.invalid", "Choose either an account recipient or a public link");

    if (!input.public && input.password)
      fail("input.invalid", "Passwords apply only to public links");
    const expiry = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;

    if (!active(expiry)) fail("input.invalid", "Expiration must be in the future");
    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const token = input.public ? randomToken() : null;

    return this.ctx.run(async (transaction, actor) => {
      const { item } = await authorizeItem(transaction, actor, input.itemId, "owner");

      if (input.recipientId) {
        const recipient = await transaction.get(UserRecord, "user", input.recipientId);

        if (recipient?.status !== "active")
          fail(
            "input.invalid",
            "Choose an existing account ID; email addresses are not verified identities",
          );

        if (recipient.key === item.ownerId) fail("input.invalid", "You already own this item");
      }

      const existing = await transaction.find(
        ShareRecord,
        "share",
        "itemId = $item AND revokedAt = NULL",
        { item: item.key },
        100,
      );

      if (input.recipientId && existing.some((share) => share.recipientId === input.recipientId))
        fail(
          "resource.conflict",
          "This account already has a direct share; revoke it before changing its role",
        );

      if (existing.length >= 100)
        fail("resource.conflict", "This item has reached the 100-share limit");

      const share: ShareRecord = {
        key: newId(),
        itemId: item.key,
        issuerId: item.ownerId,
        recipientId: input.recipientId ?? null,
        public: input.public,
        role: input.role,
        tokenHash: token ? digest(token) : null,
        passwordHash,
        expiresAt: expiry,
        revokedAt: null,
        createdAt: now(),
      };

      transaction.put("share", share);

      return projectShare(share, token ? `${this.ctx.config.origin}/share/${token}` : null);
    });
  }
  revoke(input: typeof ShareInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const share = requireValue(await transaction.get(ShareRecord, "share", input.id));
      await authorizeItem(transaction, actor, share.itemId, "owner", true);
      transaction.put("share", { ...share, revokedAt: now() });

      return { success: true as const };
    });
  }
  async resolve(input: typeof ResolveShare.Type) {
    return this.resolveToken(input.token);
  }
  async unlock(input: typeof UnlockShare.Type) {
    await consumeRate(this.ctx, `share:${digest(input.token)}`);

    return this.resolveToken(input.token, input.password);
  }
  private async resolveToken(token: string, password?: string) {
    const candidate = await this.ctx.run(
      async (transaction) =>
        (
          await transaction.find(
            ShareRecord,
            "share",
            "tokenHash = $hash AND public = true AND revokedAt = NULL",
            { hash: digest(token) },
            1,
          )
        )[0],
    );

    if (!candidate || !active(candidate.expiresAt))
      fail("access.denied", "Shared link is unavailable");

    const passwordValid =
      candidate.passwordHash && password !== undefined
        ? await verifyPassword(password, candidate.passwordHash)
        : false;

    if (password !== undefined && candidate.passwordHash && !passwordValid)
      fail("access.denied", "Incorrect link password");
    const grantToken = randomToken();

    const result = await this.ctx.run(async (transaction, actor) => {
      const share = requireValue(await transaction.get(ShareRecord, "share", candidate.key));

      if (share.revokedAt || !active(share.expiresAt) || share.tokenHash !== digest(token))
        fail("access.denied", "Shared link is unavailable");
      const owner = await transaction.get(UserRecord, "user", share.issuerId);

      if (owner?.status !== "active") fail("access.denied", "Shared link is unavailable");

      if (share.passwordHash && !passwordValid && !actor.shareIds.includes(share.key))
        return { share: projectShare(share), item: null, requiresPassword: true };
      const shareActor = { ...actor, shareIds: [...new Set([...actor.shareIds, share.key])] };
      const { item } = await authorizeItem(transaction, shareActor, share.itemId, "read");
      transaction.put("grant", {
        key: digest(grantToken),
        shareId: share.key,
        expiresAt: expires(12 * 3600000),
      });

      return {
        share: projectShare(share),
        item: projectItem(item, shareActor, [share]),
        requiresPassword: false,
      };
    });

    if (!result.requiresPassword) this.ctx.setShareCookie(result.share.id, grantToken);

    return result;
  }
}

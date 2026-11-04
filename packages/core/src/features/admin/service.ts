import { digest, hashPassword, randomToken } from "@hyori-cloud/lib/crypto";
import { transact, Stored, type Table } from "@hyori-cloud/lib/surreal";
import { UserRecord } from "#core/features/auth/db";
import { createAccount, normalizeEmail } from "#core/features/auth/service";
import type {
  CreateInvite,
  CreateUser,
  DeleteUser,
  SetQuota,
  UsersInput,
} from "#core/features/admin/api/schema";
import {
  active,
  expires,
  fail,
  publicUser,
  RequestContext,
  requireAdmin,
  requireValue,
  type Runtime,
} from "#core/runtime";

export class AdminService {
  constructor(private readonly ctx: RequestContext) {}
  users(input: typeof UsersInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      requireAdmin(actor);

      const users = await transaction.find(
        UserRecord,
        "user",
        "status != 'deleted' AND key > $cursor",
        { cursor: input.cursor ?? "" },
        101,
      );

      return {
        items: users.slice(0, 100).map((user) => ({
          ...publicUser(user),
          status: user.status === "active" ? ("active" as const) : ("deleting" as const),
          reservedBytes: user.reservedBytes,
        })),
        nextCursor: users.length > 100 ? users[99]!.key : null,
      };
    });
  }
  async createUser(input: typeof CreateUser.Type) {
    await this.ctx.run(async (_transaction, actor) => {
      requireAdmin(actor);
    });
    const passwordHash = await hashPassword(input.password);

    return this.ctx.run(async (transaction, actor) => {
      requireAdmin(actor);

      return publicUser(
        await createAccount(
          transaction,
          input,
          passwordHash,
          "user",
          input.quotaBytes ?? this.ctx.config.defaultQuotaBytes,
        ),
      );
    });
  }
  createInvite(input: typeof CreateInvite.Type) {
    const token = randomToken();

    return this.ctx.run(async (transaction, actor) => {
      const admin = requireAdmin(actor);

      const expiresAt = input.expiresAt
        ? new Date(input.expiresAt).toISOString()
        : expires(7 * 86400000);

      if (!active(expiresAt)) fail("input.invalid", "Invitation expiry must be in the future");
      transaction.put("invite", {
        key: digest(token),
        issuerId: admin.key,
        email: input.email ? normalizeEmail(input.email) : null,
        expiresAt,
        consumedAt: null,
      });

      return { token, expiresAt };
    });
  }
  setQuota(input: typeof SetQuota.Type) {
    return this.ctx.run(async (transaction, actor) => {
      requireAdmin(actor);

      const user = requireValue(
        await transaction.get(UserRecord, "user", input.userId),
        "Account not found",
      );

      if (user.status !== "active") fail("resource.conflict", "Account is being deleted");
      const updated = { ...user, quotaBytes: input.quotaBytes };
      transaction.put("user", updated);

      return publicUser(updated);
    });
  }
  async deleteUser(input: typeof DeleteUser.Type) {
    await this.ctx.run(async (transaction, actor) => {
      const admin = requireAdmin(actor);

      const user = requireValue(
        await transaction.get(UserRecord, "user", input.userId),
        "Account not found",
      );

      if (user.key === admin.key || user.role === "admin")
        fail("access.denied", "The bootstrap administrator cannot be deleted");

      if (user.status === "deleted") fail("resource.notFound", "Account not found");

      if (input.confirmEmail !== user.email)
        fail("input.invalid", "Type the exact account email to confirm deletion");
      transaction.put("user", { ...user, status: "deleting" });
    });

    return AdminService.purge(this.ctx.runtime, input.userId);
  }
  static async purge(runtime: Runtime, userId: string) {
    const eligible = await transact(runtime.database, async (transaction) => {
      const user = await transaction.get(UserRecord, "user", userId);

      return user?.status === "deleting" || user?.status === "deleted";
    });

    if (!eligible) fail("access.denied", "Account is not marked for deletion");
    const storage = await runtime.storage.purgeOwner(userId);

    const pendingMetadata = await transact(runtime.database, async (transaction) => {
      const user = requireValue(await transaction.get(UserRecord, "user", userId));

      if (user.status === "active") fail("access.denied", "Account is active");
      let pending = false;

      const scopes: readonly [Table, string][] = [
        ["item", "ownerId = $owner"],
        ["version", "ownerId = $owner"],
        ["upload", "ownerId = $owner"],
        ["share", "issuerId = $owner OR recipientId = $owner"],
        ["session", "userId = $owner"],
        ["invite", "issuerId = $owner"],
        ["album", "ownerId = $owner"],
        ["album_item", "ownerId = $owner"],
        ["sources", "key = $owner"],
      ];

      for (const [table, where] of scopes) {
        const records = await transaction.find(Stored, table, where, { owner: userId }, 100);

        for (const record of records) transaction.delete(table, record.key);
        pending ||= records.length === 100;
      }

      if (!pending && !storage.pending)
        transaction.put("user", {
          ...user,
          status: "deleted",
          name: "Deleted account",
          // This is deliberately not a registrable email, including for pre-existing collisions.
          email: `deleted:${user.key}`,
          passwordHash: "",
          usedBytes: 0,
          reservedBytes: 0,
          quotaBytes: 0,
        });

      return pending;
    });

    return {
      userId,
      state: storage.pending || pendingMetadata ? ("pending" as const) : ("complete" as const),
      deletedObjects: storage.deleted,
    };
  }
}

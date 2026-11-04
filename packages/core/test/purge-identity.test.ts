import { expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { DatabaseFailure, type SqlObject } from "@hyori-cloud/lib/surreal";
import { AdminService } from "#core/features/admin/service";
import { UserRecord } from "#core/features/auth/db";
import { normalizeEmail } from "#core/features/auth/service";
import { account, config, context, ReviewDatabase, ReviewStorage } from "#core-test/review-fixture";

class PurgeStorage extends ReviewStorage {
  override async purgeOwner(): Promise<{ deleted: number; pending: boolean }> {
    return { deleted: 0, pending: false };
  }
}

class PurgeDatabase extends ReviewDatabase {
  target: UserRecord = { ...account, key: "target", status: "deleting" };
  readonly occupiedEmail = "deleted-target@invalid.local";
  constructor() {
    super((_query, variables) => (variables.table === "hc_user" ? [this.target] : []));
  }
  override async execute(query: string, variables: SqlObject = {}): Promise<void> {
    for (const value of Object.values(variables)) {
      if (!Schema.is(UserRecord)(value)) continue;

      if (value.email === this.occupiedEmail)
        throw new DatabaseFailure("The unique email index is already occupied");
      this.target = value;
    }

    await super.execute(query, variables);
  }
}

test("purge retries escape a pre-existing, registrable tombstone email collision", async () => {
  const database = new PurgeDatabase();
  expect(normalizeEmail(database.occupiedEmail)).toBe(database.occupiedEmail);
  const ctx = context(database, new PurgeStorage(config.storage));

  try {
    expect(await AdminService.purge(ctx.runtime, database.target.key)).toMatchObject({
      state: "complete",
    });
    expect(database.target).toMatchObject({
      status: "deleted",
      email: "deleted:target",
      usedBytes: 0,
    });
    expect(() => normalizeEmail(database.target.email)).toThrow();
    expect(await AdminService.purge(ctx.runtime, database.target.key)).toMatchObject({
      state: "complete",
    });
    expect(database.target.email).not.toBe(database.occupiedEmail);
  } finally {
    ctx.runtime.storage.close();
  }
});

import { transact, Stored, type Table } from "@hyori-cloud/lib/surreal";
import { UserRecord } from "#core/features/auth/db";
import { AdminService } from "#core/features/admin/service";
import { UploadRecord } from "#core/features/uploads/db";
import { now, type Runtime } from "#core/runtime";

/** Host-owned scheduling; no request timer, public endpoint, or background success fallback. */
export class Maintenance {
  private uploadCursor = "";
  private userCursor = "";
  private running: Promise<{ uploads: number; accounts: number }> | undefined;
  constructor(private readonly runtime: Runtime) {}
  run(): Promise<{ uploads: number; accounts: number }> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }
  private async sweep() {
    await this.runtime.initialize();

    const uploads = await transact(this.runtime.database, async (transaction) =>
      transaction.find(
        UploadRecord,
        "upload",
        "key > $cursor AND (cleanupPending = true OR (expiresAt < $now AND state != 'complete'))",
        { cursor: this.uploadCursor, now: now() },
        25,
      ),
    );

    for (const candidate of uploads) {
      const upload = await transact(this.runtime.database, async (transaction) => {
        const current = await transaction.get(UploadRecord, "upload", candidate.key);

        if (
          !current ||
          current.state === "complete" ||
          (current.state === "aborted" && current.cleanupPending)
        )
          return current;
        const owner = await transaction.get(UserRecord, "user", current.ownerId);

        if (current.state !== "aborted" && owner)
          transaction.put("user", {
            ...owner,
            reservedBytes: Math.max(0, owner.reservedBytes - current.size),
          });
        const updated = { ...current, state: "aborted" as const, cleanupPending: true };
        transaction.put("upload", updated);

        return updated;
      });

      if (upload) {
        if (upload.state !== "complete" && upload.multipartId)
          await this.runtime.storage.abort(upload.objectKey, upload.multipartId);
        await this.runtime.storage.abortUnfinished(upload.objectKey);

        // Completed originals are durable content, not abandoned upload debris.
        if (upload.state !== "complete") await this.runtime.storage.remove(upload.objectKey);
      }

      this.uploadCursor = candidate.key;
    }

    if (uploads.length < 25) this.uploadCursor = "";

    const users = await transact(this.runtime.database, async (transaction) =>
      transaction.find(
        UserRecord,
        "user",
        "key > $cursor AND status != 'active'",
        { cursor: this.userCursor },
        25,
      ),
    );

    for (const user of users) {
      await AdminService.purge(this.runtime, user.key);
      this.userCursor = user.key;
    }

    if (users.length < 25) this.userCursor = "";
    await transact(this.runtime.database, async (transaction) => {
      const tables: readonly [Table, string][] = [
        ["session", "expiresAt < $now"],
        ["grant", "expiresAt < $now"],
        ["invite", "expiresAt < $now OR consumedAt != NULL"],
        ["rate", "resetAt < $now"],
      ];

      for (const [table, where] of tables)
        for (const row of await transaction.find(Stored, table, where, { now: now() }, 100))
          transaction.delete(table, row.key);
    });

    return { uploads: uploads.length, accounts: users.length };
  }
}

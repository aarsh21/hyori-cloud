import { expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { ObjectStorage } from "@hyori-cloud/lib/storage";
import type { SqlObject } from "@hyori-cloud/lib/surreal";
import { UploadRecord } from "#core/features/uploads/db";
import { UserRecord } from "#core/features/auth/db";
import { UploadsService } from "#core/features/uploads/service";
import { Maintenance } from "#core/maintenance";
import {
  account,
  config,
  context,
  identityRows,
  ReviewDatabase,
  ReviewStorage,
} from "#core-test/review-fixture";

class LostResponseStorage extends ReviewStorage {
  readonly sessions = new Set<string>();
  readonly removed: string[] = [];
  override async begin(key: string): Promise<string> {
    this.sessions.add(key);
    throw new Error("Creation response lost after storage accepted the session");
  }
  override async abortUnfinished(key: string): Promise<void> {
    this.sessions.delete(key);
  }
  override async remove(key: string): Promise<void> {
    this.removed.push(key);
  }
}

class UploadDatabase extends ReviewDatabase {
  upload: UploadRecord | null = null;
  owner = { ...account };
  constructor() {
    super((query, variables) => {
      if (variables.table === "hc_user") return [this.owner];
      const identity = identityRows(variables);

      if (identity) return identity;

      if (variables.table === "hc_upload") return this.upload ? [this.upload] : [];

      if (query.includes("FROM hc_upload"))
        return this.upload?.cleanupPending || this.upload?.state === "starting"
          ? [this.upload]
          : [];

      return [];
    });
  }
  override async execute(query: string, variables: SqlObject = {}): Promise<void> {
    await super.execute(query, variables);

    for (const [slot, value] of Object.entries(variables)) {
      if (!/^v\d+$/.test(slot)) continue;

      if (Schema.is(UploadRecord)(value)) this.upload = value;

      if (Schema.is(UserRecord)(value)) this.owner = value;
    }
  }
}

test("a lost multipart creation response is reconciled by its durable key", async () => {
  const database = new UploadDatabase();
  const storage = new LostResponseStorage(config.storage);
  const ctx = context(database, storage);

  try {
    await expect(
      new UploadsService(ctx).begin({
        name: "lost.txt",
        parentId: null,
        size: 5,
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("Creation response lost");
    expect(database.upload).toMatchObject({
      state: "aborted",
      multipartId: null,
      cleanupPending: true,
    });
    expect(database.owner.reservedBytes).toBe(0);
    expect(storage.sessions.size).toBe(0);
    expect(storage.removed).toEqual([database.upload!.objectKey]);

    // An in-flight create can settle after cancellation. The durable marker catches it later.
    storage.sessions.add(database.upload!.objectKey);
    await new Maintenance(ctx.runtime).run();
    expect(storage.sessions.size).toBe(0);
    expect(database.owner.reservedBytes).toBe(0);
  } finally {
    storage.close();
  }
});

test("restart before ID persistence reconciles starting uploads without double quota release", async () => {
  const database = new UploadDatabase();
  database.owner = { ...account, reservedBytes: 5 };
  database.upload = {
    key: "starting",
    name: "start.txt",
    parentId: null,
    size: 5,
    mimeType: "text/plain",
    ownerId: account.key,
    initiator: `user:${account.key}`,
    uploaderId: account.key,
    objectKey: "owners/reader/starting",
    multipartId: null,
    replaceId: null,
    replaceRevision: null,
    state: "starting",
    parts: [],
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z",
    fileId: null,
    cleanupPending: false,
  };
  const storage = new LostResponseStorage(config.storage);
  storage.sessions.add(database.upload.objectKey);
  const ctx = context(database, storage);

  try {
    const maintenance = new Maintenance(ctx.runtime);
    await maintenance.run();
    const writes = database.writes.length;
    await maintenance.run();
    expect(database.writes.length).toBe(writes);
    expect(database.upload).toMatchObject({ state: "aborted", cleanupPending: true });
    expect(storage.sessions.size).toBe(0);
    expect(database.owner.reservedBytes).toBe(0);

    // A successful finalization keeps its original while unfinished duplicates are removed.
    database.upload = { ...database.upload!, state: "complete", fileId: "published" };
    storage.sessions.add(database.upload.objectKey);
    const deletions = storage.removed.length;
    await maintenance.run();
    expect(storage.sessions.size).toBe(0);
    expect(storage.removed.length).toBe(deletions);
    expect(database.owner.reservedBytes).toBe(0);
  } finally {
    storage.close();
  }
});

test("owned S3 adapter bounds multipart reconciliation, retains the live ID and ignores prefix neighbours", async () => {
  const aborted: string[] = [];
  const requests: URL[] = [];
  const key = "owners/reader/object";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url);

      if (request.method === "GET")
        return new Response(
          `<?xml version="1.0"?><ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Upload><Key>${key}</Key><UploadId>lost-response</UploadId></Upload><Upload><Key>${key}</Key><UploadId>live</UploadId></Upload><Upload><Key>${key}</Key><UploadId>retry-duplicate</UploadId></Upload><Upload><Key>${key}-neighbour</Key><UploadId>unrelated</UploadId></Upload></ListMultipartUploadsResult>`,
          { headers: { "Content-Type": "application/xml" } },
        );

      if (request.method === "DELETE") {
        aborted.push(url.searchParams.get("uploadId") ?? "");

        return new Response(null, { status: 204 });
      }

      throw new Error("Unexpected fake S3 operation");
    },
  });

  const storage = new ObjectStorage({
    ...config.storage,
    endpoint: `http://127.0.0.1:${server.port}`,
  });

  try {
    await storage.abortUnfinished(key, "live");
    expect(requests[0]?.searchParams.get("max-uploads")).toBe("100");
    expect(requests[0]?.searchParams.get("prefix")).toBe(key);
    expect(aborted).toEqual(["lost-response", "retry-duplicate"]);
    expect(requests.filter((url) => !url.searchParams.has("uploadId"))).toHaveLength(1);
  } finally {
    storage.close();
    await server.stop(true);
  }
});

import { Schema } from "@hyori-cloud/lib/effect";
import { SurrealDatabase, type SqlObject, type SqlValue } from "@hyori-cloud/lib/surreal";
import { ObjectStorage } from "@hyori-cloud/lib/storage";
import type { UserRecord } from "#core/features/auth/db";
import type { ItemRecord } from "#core/features/files/db";
import type { ShareRecord } from "#core/features/shares/db";
import { Runtime, RequestContext, type ServerConfig } from "#core/runtime";

export const config: ServerConfig = {
  origin: "http://review.invalid",
  secureCookies: false,
  setupToken: "isolated-review-fixture-token",
  surreal: {
    url: "http://database.invalid",
    namespace: "review",
    database: "review",
    username: "test",
    password: "test",
  },
  storage: {
    endpoint: "http://storage.invalid",
    bucket: "review",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
  },
};

export const account: UserRecord = {
  key: "reader",
  email: "reader@example.test",
  name: "Reader",
  role: "user",
  quotaBytes: 100,
  usedBytes: 0,
  reservedBytes: 0,
  passwordHash: "test",
  status: "active",
};

export const folder: ItemRecord = {
  key: "folder",
  name: "Pictures",
  kind: "folder",
  parentId: null,
  ownerId: "owner",
  size: 0,
  mimeType: "inode/directory",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  trashedAt: null,
  trashRoot: null,
  ancestorIds: [],
  objectKey: null,
  uploadedBy: "owner",
  revision: 0,
};

export const share: ShareRecord = {
  key: "share",
  itemId: folder.key,
  issuerId: "owner",
  recipientId: account.key,
  role: "contributor",
  public: false,
  expiresAt: null,
  revokedAt: null,
  tokenHash: null,
  passwordHash: null,
  createdAt: folder.createdAt,
};

/** Scripted persistence capability: every returned row still passes its owning codec. */
export class ReviewDatabase extends SurrealDatabase {
  revision = 0;
  writes: SqlObject[] = [];
  constructor(readonly respond: (query: string, variables: SqlObject) => SqlValue) {
    super(config.surreal);
  }
  override async initialize(): Promise<void> {}
  override async query<T, I>(
    query: string,
    schema: Schema.Schema<T, I>,
    variables: SqlObject = {},
  ): Promise<T[]> {
    const value = query.startsWith("SELECT revision")
      ? [{ revision: this.revision, initialized: true }]
      : this.respond(query, variables);

    return [Schema.decodeUnknownSync(schema)(value)];
  }
  override async execute(_query: string, variables: SqlObject = {}): Promise<void> {
    this.writes.push(variables);
    this.revision += 1;
  }
}

export class ReviewStorage extends ObjectStorage {
  override async ensureBucket(): Promise<void> {}
}

export function context(database: ReviewDatabase, storage = new ReviewStorage(config.storage)) {
  const runtime = new Runtime(config, { database, storage });
  const request = new Request(config.origin, { headers: { Cookie: "hyori_session=test-session" } });

  return new RequestContext(runtime, request);
}

export function identityRows(variables: SqlObject): SqlValue | undefined {
  if (variables.table === "hc_session")
    return [
      { key: String(variables.key), userId: account.key, expiresAt: "2099-01-01T00:00:00.000Z" },
    ];

  if (variables.table === "hc_user") return [{ ...account, key: String(variables.key) }];

  return undefined;
}

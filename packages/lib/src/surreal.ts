import { Either, Schema } from "@hyori-cloud/lib/effect";

export type SqlValue = string | number | boolean | null | readonly SqlValue[] | SqlObject;

export type SqlObject = { readonly [key: string]: SqlValue };

const QueryResponse = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ status: Schema.Literal("OK", "ERR"), result: Schema.Unknown }),
  ),
  error: Schema.optional(Schema.Unknown),
});

const ControlRecord = Schema.Struct({
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  initialized: Schema.Boolean,
});

export type SurrealConfig = {
  url: string;
  namespace: string;
  database: string;
  username: string;
  password: string;
};

export class DatabaseFailure extends Error {}

export class WriteConflict extends Error {}

/** Parameter-bound Surreal HTTP RPC. Credentials never enter the public API graph. */
export class SurrealDatabase {
  private readonly endpoint: string;
  constructor(private readonly config: SurrealConfig) {
    this.endpoint = `${config.url.replace(/\/$/, "").replace(/\/(rpc|sql)$/, "")}/rpc`;
  }
  async query<T, I>(
    query: string,
    schema: Schema.Schema<T, I>,
    variables: SqlObject = {},
  ): Promise<T[]> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Surreal-NS": this.config.namespace,
        "Surreal-DB": this.config.database,
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
      },
      body: JSON.stringify({ id: 1, method: "query", params: [query, variables] }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) throw new DatabaseFailure(`Database HTTP ${response.status}`);

    const decoded = Schema.decodeUnknownEither(QueryResponse)(await response.json());

    if (Either.isLeft(decoded)) throw new DatabaseFailure("Invalid database RPC response");
    const body = decoded.right;

    if (body.error) throw new DatabaseFailure("Database RPC rejected");
    const failures = body.result.filter((result) => result.status !== "OK");

    if (failures.length) {
      const message = failures.map((result) => String(result.result)).join("; ");

      if (
        message.includes("hc.write-conflict") ||
        /transaction.*conflict|transaction.*retry|read or write conflict/i.test(message)
      )
        throw new WriteConflict(message);
      throw new DatabaseFailure(message);
    }

    return body.result.map((entry) => {
      const result = Schema.decodeUnknownEither(schema)(entry.result);

      if (Either.isLeft(result)) throw new DatabaseFailure("Invalid database statement result");

      return result.right;
    });
  }
  async execute(query: string, variables: SqlObject = {}): Promise<void> {
    await this.query(query, Schema.Unknown, variables);
  }
  async initialize(): Promise<void> {
    await this.execute(`
      DEFINE TABLE IF NOT EXISTS hc_control SCHEMALESS;
      UPSERT hc_control:global SET revision = 0, initialized = false WHERE revision = NONE;
      DEFINE TABLE IF NOT EXISTS hc_user SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_user_email ON hc_user FIELDS email UNIQUE;
      DEFINE TABLE IF NOT EXISTS hc_session SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_session_user ON hc_session FIELDS userId;
      DEFINE TABLE IF NOT EXISTS hc_item SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_item_parent ON hc_item FIELDS ownerId, parentId, key;
      DEFINE INDEX IF NOT EXISTS hc_item_owner ON hc_item FIELDS ownerId, key;
      DEFINE TABLE IF NOT EXISTS hc_version SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_version_file ON hc_version FIELDS fileId, key;
      DEFINE TABLE IF NOT EXISTS hc_upload SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_upload_owner ON hc_upload FIELDS ownerId, key;
      DEFINE TABLE IF NOT EXISTS hc_share SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_share_recipient ON hc_share FIELDS recipientId, itemId;
      DEFINE INDEX IF NOT EXISTS hc_share_item ON hc_share FIELDS itemId;
      DEFINE INDEX IF NOT EXISTS hc_share_token ON hc_share FIELDS tokenHash;
      DEFINE TABLE IF NOT EXISTS hc_grant SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hc_invite SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hc_rate SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hc_sources SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hc_album SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS hc_album_item SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS hc_album_members ON hc_album_item FIELDS albumId, fileId UNIQUE;
    `);
  }
}

export type Table =
  | "user"
  | "session"
  | "item"
  | "version"
  | "upload"
  | "share"
  | "grant"
  | "invite"
  | "rate"
  | "sources"
  | "album"
  | "album_item";

export const Stored = Schema.Struct({ key: Schema.String });

export type Stored = typeof Stored.Type;

export class Transaction {
  private statements: string[] = [];
  private variables: { [name: string]: SqlValue } = {};
  constructor(private readonly database: SurrealDatabase) {}
  async get<T extends Stored, I>(
    schema: Schema.Schema<T, I>,
    table: Table,
    id: string,
  ): Promise<T | null> {
    const [rows] = await this.database.query(
      `SELECT * OMIT id FROM type::thing($table, $key)`,
      Schema.Array(schema),
      { table: `hc_${table}`, key: id },
    );

    return rows?.[0] ?? null;
  }
  async find<T extends Stored, I>(
    schema: Schema.Schema<T, I>,
    table: Table,
    where: string,
    variables: SqlObject = {},
    limit = 100,
    order = "key ASC",
  ): Promise<T[]> {
    const [rows] = await this.database.query(
      `SELECT * OMIT id FROM hc_${table} WHERE ${where} ORDER BY ${order} LIMIT $limit`,
      Schema.mutable(Schema.Array(schema)),
      { ...variables, limit },
    );

    return rows ?? [];
  }
  put<T extends Stored & SqlObject>(table: Table, row: T): void {
    const slot = `v${this.statements.length}`;
    this.variables[slot] = row;
    this.variables[`${slot}key`] = row.key;
    this.statements.push(`UPSERT type::thing('hc_${table}', $${slot}key) CONTENT $${slot};`);
  }
  delete(table: Table, key: string): void {
    const slot = `k${this.statements.length}`;
    this.variables[slot] = key;
    this.statements.push(`DELETE type::thing('hc_${table}', $${slot});`);
  }
  setInitialized(): void {
    this.statements.push("UPDATE hc_control:global SET initialized = true;");
  }
  async control(): Promise<{ revision: number; initialized: boolean }> {
    const [rows] = await this.database.query(
      "SELECT revision, initialized FROM hc_control:global",
      Schema.Array(ControlRecord),
    );

    if (!rows?.[0]) throw new DatabaseFailure("Missing control row");

    return rows[0];
  }
  async commit(revision: number): Promise<void> {
    if (!this.statements.length) {
      // A read must not combine authorization from before a write with data from after it.
      if ((await this.control()).revision !== revision)
        throw new WriteConflict("Read snapshot changed");

      return;
    }

    await this.database.execute(
      `BEGIN TRANSACTION;
      LET $guard = UPDATE hc_control:global SET revision += 1 WHERE revision = $revision RETURN AFTER;
      IF array::len($guard) != 1 { THROW 'hc.write-conflict'; };
      ${this.statements.join("\n")}
      COMMIT TRANSACTION;`,
      { revision, ...this.variables },
    );
  }
}

/** Optimistic serializability across processes, including authorization reads. Callbacks must have no external side effects. */
export async function transact<T>(
  database: SurrealDatabase,
  action: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const transaction = new Transaction(database);
    const { revision } = await transaction.control();

    try {
      const result = await action(transaction);
      await transaction.commit(revision);

      return result;
    } catch (error) {
      if (!(error instanceof WriteConflict) || attempt === 5) throw error;
    }
  }

  throw new WriteConflict("Retry limit");
}

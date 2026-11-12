// Operator tooling client: the public SDK over the deployment's real HTTPS gateway, one cookie jar per
// session. Used by the dataset, drill and capacity scripts; it never talks to private ports.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  normalizeClientError,
  type ClientError,
  type UploadFile,
} from "@hyori-cloud/client-sdk";
import { z } from "zod";

export type Session = ReturnType<typeof connect>;

export type GatewayOptions = {
  /** Exact public HTTPS origin, the deployment's APP_ORIGIN. */
  readonly origin: string;
  /** PEM CA that signs the gateway certificate; omit for a publicly trusted certificate. */
  readonly caPath?: string;
};

/** `--name value` pairs from argv, with defaults from the environment. */
export function options(argv = process.argv.slice(2)) {
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg.startsWith("--")) values.set(arg.slice(2), argv[++index] ?? "");
    else positional.push(arg);
  }

  return {
    positional,
    get: (name: string, fallback?: string) => {
      const value = values.get(name) ?? fallback;

      if (value === undefined) throw new Error(`Pass --${name}.`);

      return value;
    },
    gateway: (): GatewayOptions => ({
      origin: values.get("origin") ?? process.env.HYORI_OPS_ORIGIN ?? fail("Pass --origin."),
      caPath: values.get("ca") ?? process.env.HYORI_OPS_CA,
    }),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

// Like a browser, tooling keeps each account's cookies (session and `hyori_device`) across runs.
// Logging in afresh every run would trip the login limit: 10 attempts per 15 minutes per account and
// device, and behind a gateway without a device cookie, per account for every client together.
const cookieJar = join(tmpdir(), "hyori-ops-cookies.json");

function jars(): Record<string, [string, string][]> {
  return existsSync(cookieJar) ? JSON.parse(readFileSync(cookieJar, "utf8")) : {};
}

export function connect(gateway: GatewayOptions, account?: string) {
  const ca = gateway.caPath ? readFileSync(gateway.caPath, "utf8") : undefined;
  const jarKey = `${gateway.origin} ${account ?? ""}`;
  const cookies = new Map<string, string>(account ? (jars()[jarKey] ?? []) : []);

  const send = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    // A browser sends its Origin; the web host rejects state changes without it.
    request.headers.set("origin", gateway.origin);

    if (cookies.size) request.headers.set("cookie", [...cookies.values()].join("; "));
    const response = await fetch(request, ca ? { tls: { ca } } : {});

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const name = pair.slice(0, pair.indexOf("="));

      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
      else cookies.set(name, pair);
    }

    if (account && response.headers.getSetCookie().length)
      writeFileSync(cookieJar, JSON.stringify({ ...jars(), [jarKey]: [...cookies] }), {
        mode: 0o600,
      });

    return response;
  };

  const sdk = createClient({ baseUrl: `${gateway.origin}/api/rpc`, fetch: send });

  return { sdk, send, gateway };
}

/** Reuse the account's saved session when it is still valid; otherwise log in. */
export async function login(gateway: GatewayOptions, email: string, password: string) {
  const session = connect(gateway, email);

  if ((await session.sdk.rpc.auth.status({})).user?.email !== email)
    await session.sdk.rpc.auth.login({ email, password });

  return session;
}

/** A disk-backed file the SDK can slice without holding it in memory. */
export function diskFile(
  path: string,
  name: string,
  type = "application/octet-stream",
): UploadFile {
  const blob = Bun.file(path);

  return {
    name,
    size: blob.size,
    type,
    lastModified: blob.lastModified,
    slice: (start?: number, end?: number, contentType?: string) =>
      blob.slice(start, end, contentType),
  };
}

export async function sha256File(path: string) {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

  return hash.digest("hex");
}

/** Hash a download stream without buffering it; returns bytes and SHA-256. */
export async function hashStream(stream: ReadableStream<Uint8Array>) {
  const hash = createHash("sha256");
  let bytes = 0;

  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }

  return { bytes, sha256: hash.digest("hex") };
}

/** Write `size` bytes of incompressible data to `path` in 8 MiB blocks and return its SHA-256. */
export async function writeRandomFile(path: string, size: number) {
  const { randomBytes } = await import("node:crypto");
  const writer = Bun.file(path).writer();
  const hash = createHash("sha256");

  for (let written = 0; written < size;) {
    const block = randomBytes(Math.min(8 * 1024 * 1024, size - written));
    hash.update(block);
    writer.write(block);
    written += block.byteLength;
  }

  await writer.end();

  return hash.digest("hex");
}

export function percentile(sorted: readonly number[], p: number) {
  if (!sorted.length) return Number.NaN;

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** What a user is shown for a failure: the declared API error or the SDK's own classification. */
export function describe(error: ClientError) {
  return { code: error.code, message: error.message };
}

/** Parse a caught failure with the SDK's own error contract. */
export const clientError = normalizeClientError;

const FileRecord = z.object({
  id: z.string(),
  path: z.string(),
  size: z.number(),
  sha256: z.string(),
  versions: z.array(z.object({ id: z.string(), size: z.number(), sha256: z.string() })),
  trashed: z.boolean().optional(),
});

export type FileRecord = z.infer<typeof FileRecord>;

const Account = z.object({ email: z.string(), password: z.string(), id: z.string() });

/** The seeded dataset written by `ops-dataset.ts seed`; it holds fixture passwords. */
export const Manifest = z.object({
  createdAt: z.string(),
  owner: Account,
  member: Account,
  folders: z.record(z.string(), z.string()),
  files: z.array(FileRecord),
  memberFiles: z.array(FileRecord),
  shares: z.array(
    z.object({
      id: z.string(),
      itemId: z.string(),
      role: z.string(),
      public: z.boolean(),
      recipientId: z.string().nullable(),
      url: z.string().nullable(),
      password: z.string().optional(),
    }),
  ),
  album: z.object({ id: z.string(), name: z.string(), fileIds: z.array(z.string()) }),
});

export type Manifest = z.infer<typeof Manifest>;

export async function readManifest(path: string) {
  return Manifest.parse(await Bun.file(path).json());
}

/** One line of an `ops-churn.ts` log. */
export const ChurnEntry = z.object({
  at: z.string(),
  worker: z.number(),
  op: z.enum(["upload", "replace", "trash", "download"]),
  ok: z.boolean(),
  ms: z.number(),
  id: z.string().optional(),
  sha256: z.string().optional(),
  error: z.string().optional(),
  detail: z.string().optional(),
});

export type ChurnEntry = z.infer<typeof ChurnEntry>;

export function readChurnLog(path: string) {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => (line ? [ChurnEntry.parse(JSON.parse(line))] : []));
}

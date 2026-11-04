import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const [tokenPath, originInput] = process.argv.slice(2);

if (!tokenPath || !originInput) {
  throw new Error("Usage: bun scripts/configure-local.ts <private-token-file> <app-origin>");
}

const origin = new URL(originInput);

if (origin.origin !== originInput || !["http:", "https:"].includes(origin.protocol)) {
  throw new Error("Supply a complete HTTP(S) origin without a path.");
}

const token = (await readFile(tokenPath, "utf8")).trim();

if (token.length < 24 || token.length > 256 || /[\r\n\0]/.test(token)) {
  throw new Error("The private setup token must contain 24–256 characters on one line.");
}

const destination = new URL("../apps/web/.env", import.meta.url);

try {
  if ((await readFile(destination, "utf8")).trim()) {
    throw new Error(
      "Local environment already has values; edit it explicitly instead of overwriting.",
    );
  }

  await chmod(destination, 0o600);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const values = {
  NODE_ENV: "development",
  APP_ENV: "development",
  APP_ORIGIN: origin.origin,
  HYORI_SETUP_TOKEN: token,
  SURREALDB_URL: "http://127.0.0.1:8000",
  SURREALDB_NAMESPACE: "hyori",
  SURREALDB_DATABASE: "cloud",
  SURREALDB_USERNAME: "root",
  SURREALDB_PASSWORD: randomBytes(32).toString("hex"),
  RUSTFS_ENDPOINT: "http://127.0.0.1:9000",
  RUSTFS_REGION: "us-east-1",
  RUSTFS_BUCKET: "hyori-cloud",
  RUSTFS_ACCESS_KEY: randomBytes(16).toString("hex"),
  RUSTFS_SECRET_KEY: randomBytes(32).toString("hex"),
  DEFAULT_QUOTA_BYTES: String(10 * 1024 ** 3),
};

await writeFile(
  destination,
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);

console.log(
  "Configured the ignored local environment with private, distinct service credentials. Values were not printed.",
);

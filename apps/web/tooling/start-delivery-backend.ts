/** Local review stack only: reuse dev-stack's disposable state with a frozen binary and worker.
 * Run as a supervised service, not against an existing deployment's secrets or data.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const secrets = z
  .object({
    pg: z.string(),
    setup: z.string(),
    auth: z.string(),
    s3Key: z.string(),
    s3Secret: z.string(),
  })
  .parse(JSON.parse(await readFile(join(homedir(), "hyori-dev/secrets.json"), "utf8")));

const binary = process.env.HYORI_DELIVERY_BINARY;
const origin = process.env.HYORI_DELIVERY_ORIGIN;

if (!binary || !origin) throw new Error("Set HYORI_DELIVERY_BINARY and HYORI_DELIVERY_ORIGIN");

const child = spawn(binary, [], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    APP_ENV: "production",
    APP_ORIGIN: new URL(origin).origin,
    HYORI_SERVER_BIND: "127.0.0.1:23003",
    HYORI_DATABASE_URL: `postgres://hyori:${secrets.pg}@127.0.0.1:25432/hyori`,
    HYORI_SETUP_TOKEN: secrets.setup,
    HYORI_AUTH_SECRET: secrets.auth,
    HYORI_STORAGE_ENDPOINT: "http://127.0.0.1:29000",
    HYORI_STORAGE_REGION: "us-east-1",
    HYORI_STORAGE_BUCKET: "hyori",
    HYORI_STORAGE_ACCESS_KEY: secrets.s3Key,
    HYORI_STORAGE_SECRET_KEY: secrets.s3Secret,
    HYORI_MEDIA_WORKER_SOCKET: process.env.HYORI_DELIVERY_MEDIA_SOCKET,
  },
});

process.on("SIGTERM", () => child.kill("SIGTERM"));

process.on("SIGINT", () => child.kill("SIGINT"));

child.once("exit", (code) => process.exit(code ?? 1));

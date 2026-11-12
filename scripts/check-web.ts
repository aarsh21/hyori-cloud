import { readFile, stat } from "node:fs/promises";
import { availablePort } from "./available-port.ts";
import { z } from "zod";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const WebGates = z.object({
  buildMaximumSeconds: z.number().int().positive(),
  devStartupMaximumSeconds: z.number().int().positive(),
});

const config = WebGates.parse(
  JSON.parse(await readFile(new URL("../tooling/web-gates.json", import.meta.url), "utf8")),
);

function start(args: string[]) {
  return spawn("bun", args, { stdio: "inherit", detached: true, env: process.env });
}

function stop(child: ReturnType<typeof start>): void {
  if (!child.pid || child.exitCode !== null) return;

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* Already exited. */
  }
}

const build = start(["run", "--filter", "web", "build"]);
const buildTimeout = setTimeout(() => stop(build), config.buildMaximumSeconds * 1000);

try {
  const code = await new Promise<number>((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", (code) => resolve(code ?? 1));
  });

  if (code !== 0) throw new Error("Web build failed or exceeded its configured time limit.");
} finally {
  clearTimeout(buildTimeout);
  stop(build);
}

const assetRoot = new URL("../apps/web/.output/public/", import.meta.url);

const manifest = z
  .record(
    z.string(),
    z.object({
      file: z.string(),
      imports: z.array(z.string()).optional(),
      isEntry: z.boolean().optional(),
    }),
  )
  .parse(JSON.parse(await readFile(new URL(".vite/manifest.json", assetRoot), "utf8")));

const initialFiles = new Set<string>();

function include(key: string) {
  const asset = manifest[key];

  if (!asset) throw new Error(`Missing initial asset ${key}`);

  if (initialFiles.has(asset.file)) return;
  initialFiles.add(asset.file);

  for (const dependency of asset.imports ?? []) include(dependency);
}

for (const [key, asset] of Object.entries(manifest)) if (asset.isEntry) include(key);

let initialRaw = 0;
let initialBrotli = 0;

for (const file of initialFiles) {
  if (!file.endsWith(".js")) continue;
  const raw = (await stat(new URL(file, assetRoot))).size;
  const brotli = await stat(new URL(`${file}.br`, assetRoot)).catch(() => null);
  initialRaw += raw;
  initialBrotli += brotli?.size ?? raw;
}

console.log(`Initial JavaScript: ${initialRaw} raw bytes; ${initialBrotli} Brotli wire bytes.`);

if (initialFiles.size === 0 || initialRaw > 720_000 || initialBrotli > 202_000)
  throw new Error("Initial JavaScript exceeds the first-load budget (720 KB raw / 202 KB Brotli).");

const port = await availablePort();

const server = start([
  "run",
  "--filter",
  "web",
  "dev",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
]);

const deadline = Date.now() + config.devStartupMaximumSeconds * 1000;
let ready = false;

try {
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });

      await response.body?.cancel();

      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Vite has not opened its listener yet. */
    }

    await delay(200);
  }

  if (!ready)
    throw new Error("Web dev startup did not reach HTTP 200 within its configured limit.");
  console.log(
    "Web build and dev-startup gates passed; browser hydration/backend availability are separate checks.",
  );
} finally {
  stop(server);
}

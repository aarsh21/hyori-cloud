import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";
import { createLogger, createServer } from "vite";
import type { Connect, Plugin } from "vite";
import { z } from "zod";
import { requestDisconnectBoundary } from "../tooling/request-disconnect.ts";

const ENTRY = fileURLToPath(new URL("./fixtures/dev-server.ts", import.meta.url));
const errorPayload = z.object({ type: z.literal("error"), err: z.object({ message: z.string() }) });

test("Nitro disconnects do not broadcast HMR errors; real failures still do", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "hyori-dev-disconnect-"));
  const errors: string[] = [];
  const hmrErrors: string[] = [];
  const observedAbort = Promise.withResolvers<NodeJS.ErrnoException>();
  const observedBug = Promise.withResolvers<Error>();
  const allHmrErrors = Promise.withResolvers<void>();
  const logger = createLogger("silent");
  logger.error = (message) => {
    errors.push(message);
  };

  const observeErrors: Plugin = {
    name: "observe-test-errors",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/__probe-error") return next(new Error("Deliberate connected failure"));

        if (req.url === "/__probe-reset")
          return next(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));

        if (req.url === "/__probe-abort") return next(new DOMException("aborted", "AbortError"));

        if (req.url === "/__probe-disconnected-bug") {
          req.once("aborted", () => next(new Error("Deliberate disconnected failure")));

          return;
        }

        next();
      });

      return () => {
        const observe: Connect.ErrorHandleFunction = (error, req, _res, next) => {
          if (req.url === "/read-body") observedAbort.resolve(error);

          if (req.url === "/__probe-disconnected-bug") observedBug.resolve(error);
          next(error);
        };

        server.middlewares.use(observe);
      };
    },
  };

  // No app config, environment files, services or user data: only the real Nitro/Vite bridge.
  const server = await createServer({
    configFile: false,
    envFile: false,
    root: directory,
    customLogger: logger,
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      fs: { allow: [directory, fileURLToPath(new URL("../../../", import.meta.url))] },
    },
    plugins: [
      nitro({
        rootDir: directory,
        workspaceDir: directory,
        serverEntry: { handler: ENTRY },
        scanDirs: [],
      }),
      observeErrors,
      requestDisconnectBoundary(),
    ],
  });

  let hmr: WebSocket | undefined;

  context.after(async () => {
    hmr?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  await server.listen();
  const url = server.resolvedUrls?.local[0];

  assert.ok(url);
  const origin = new URL(url).origin;
  const warm = await fetch(`${origin}/healthy`);

  assert.equal(await warm.text(), "fixture ready");
  hmr = new WebSocket(origin.replace(/^http/, "ws"), "vite-hmr");
  hmr.addEventListener("message", (event) => {
    const payload = errorPayload.safeParse(JSON.parse(z.string().parse(event.data)));

    if (payload.success) {
      hmrErrors.push(payload.data.err.message);

      if (hmrErrors.length === 4) allHmrErrors.resolve();
    }
  });
  await once(hmr, "open");

  async function disconnect(path: string) {
    const incoming = Promise.withResolvers<void>();

    const received = (req: IncomingMessage) => {
      if (req.url === path) incoming.resolve();
    };

    server.httpServer?.on("request", received);

    const partial = request(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "65536" },
    });

    partial.on("error", () => {});

    try {
      partial.write("{");
      await incoming.promise;
    } finally {
      partial.destroy();
      server.httpServer?.off("request", received);
    }
  }

  await disconnect("/read-body");
  const aborted = await observedAbort.promise;

  assert.equal(aborted.message, "aborted");
  assert.equal(aborted.code, "ECONNRESET");
  assert.equal(errors.length, 0, "expected disconnects must not reach Vite's error/HMR handler");

  for (const path of ["/__probe-error", "/__probe-reset", "/__probe-abort"]) {
    const failure = await fetch(`${origin}${path}`);
    await failure.text();

    assert.equal(failure.status, 500, `${path} must remain a visible server failure`);
  }

  await disconnect("/__probe-disconnected-bug");
  assert.equal((await observedBug.promise).message, "Deliberate disconnected failure");
  await allHmrErrors.promise;

  assert.equal(errors.length, 4);
  assert.deepEqual(hmrErrors, [
    "Deliberate connected failure",
    "aborted",
    "aborted",
    "Deliberate disconnected failure",
  ]);
});

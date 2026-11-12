/** Exercise the built Nitro → Start request → existing proxy path, including raw header evidence. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { availablePort } from "../../../scripts/available-port.ts";

const calls: { address: string | null; cookie: string | null }[] = [];
let busy = false;

const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    calls.push({
      address: request.headers.get("x-hyori-client-address"),
      cookie: request.headers.get("cookie"),
    });

    return busy
      ? Response.json(
          { ok: false, error: { code: "service.unavailable", message: "Busy" } },
          { status: 503 },
        )
      : Response.json({ ok: true, value: { initialized: true, user: null } });
  },
});

const port = await availablePort();

const server = spawn("node", [".output/server/index.mjs"], {
  cwd: new URL("../", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "production",
    APP_ENV: "production",
    APP_ORIGIN: "https://cloud.example.test",
    HYORI_BACKEND_URL: backend.url.origin,
    HYORI_GATEWAY_CLIENT_ADDRESS_HEADER: "x-forwarded-for",
    PORT: String(port),
    HOST: "127.0.0.1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

let errors = "";

server.stderr.on("data", (chunk) => (errors += String(chunk)));

try {
  const readyUntil = Date.now() + 15_000;

  while (true) {
    if (server.exitCode !== null) throw new Error(`Host exited: ${errors}`);

    try {
      await fetch(`http://127.0.0.1:${port}/favicon.ico`);
      break;
    } catch {
      if (Date.now() > readyUntil) throw new Error(`Host startup timeout: ${errors}`);
      await delay(50);
    }
  }

  for (const refused of [false, true]) {
    busy = refused;
    calls.length = 0;

    const response = await fetch(`http://127.0.0.1:${port}/folders/private-folder`, {
      headers: {
        host: "cloud.example.test",
        cookie: "hyori_session=visitor",
        "x-forwarded-for": "192.0.2.10, 203.0.113.17",
        "x-hyori-client-address": "198.51.100.99",
      },
    });

    const html = await response.text();
    assert.equal(response.status, 200, `a refused SSR read must still return the app: ${errors}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(calls, [{ address: "203.0.113.17", cookie: "hyori_session=visitor" }]);
    assert.ok(!html.includes('data-slot="app-shell"'));
    assert.ok(!html.includes("hyori_session=visitor"));
    assert.doesNotMatch(
      html,
      /role="alert"/,
      "failed reads fall back to the browser's pending state",
    );

    if (!refused) assert.ok(html.includes("login-email"));
    console.log(
      `PASS built render: visitor cookie/address, no-store, no private chrome; busy=${refused}`,
    );
  }
} finally {
  server.kill("SIGTERM");
  backend.stop(true);
}

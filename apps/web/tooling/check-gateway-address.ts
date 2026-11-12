/** Build apps/web first, then run with Bun. Starts only disposable local listeners.
 * Verifies real Node/Nitro raw-header preservation, not a synthetic Request runtime.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { availablePort } from "../../../scripts/available-port.ts";

const origin = "https://cloud.example.test";

const backend = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (incoming) => Response.json(Object.fromEntries(incoming.headers)),
});

try {
  for (const optedIn of [false, true]) {
    const port = await availablePort();

    const child = spawn("node", [".output/server/index.mjs"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        APP_ENV: "production",
        APP_ORIGIN: origin,
        HYORI_BACKEND_URL: backend.url.origin,
        HYORI_GATEWAY_CLIENT_ADDRESS_HEADER: optedIn ? "x-forwarded-for" : "",
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });

    try {
      const deadline = Date.now() + 30_000;
      let ready = false;

      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, diagnostic);

        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          });

          await response.body?.cancel();

          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* The disposable Nitro listener has not opened yet. */
        }

        await Bun.sleep(100);
      }

      assert.ok(ready, diagnostic);

      for (const [fields, expected] of [
        [["X-Forwarded-For", "198.51.100.9, 203.0.113.8"], "203.0.113.8"],
        [["X-Forwarded-For", "2001:db8::5"], "2001:db8::5"],
        [["X-Forwarded-For", "198.51.100.9", "X-Forwarded-For", "203.0.113.8"], undefined],
        [["X-Forwarded-For", "203.0.113.8, garbage"], undefined],
        [[], undefined],
      ] as const) {
        const headers = await new Promise<unknown>((resolve, reject) => {
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/storage/files/fixture",
              headers: [
                "Host",
                "cloud.example.test",
                "X-Hyori-Client-Address",
                "192.0.2.250",
                "Forwarded",
                "for=192.0.2.250",
                "X-Real-IP",
                "192.0.2.250",
                ...fields,
              ],
            },
            (response) => {
              let body = "";
              response.on("data", (chunk: Buffer) => {
                body += chunk.toString();
              });
              response.on("error", reject);
              response.on("end", () => {
                try {
                  assert.equal(response.statusCode, 200);
                  resolve(JSON.parse(body));
                } catch (error) {
                  reject(error);
                }
              });
            },
          );

          outgoing.on("error", reject);
          outgoing.end();
        });

        const forwarded = z.record(z.string(), z.string()).parse(headers);
        assert.equal(forwarded["x-hyori-client-address"], optedIn ? expected : undefined);

        for (const name of ["forwarded", "x-real-ip", "x-forwarded-for"])
          assert.equal(forwarded[name], undefined);
      }

      console.log(
        `PASS built Nitro: gateway opt-in ${optedIn ? "on" : "off"}, five raw HTTP cases including duplicate fields`,
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    }
  }
} finally {
  backend.stop(true);
}

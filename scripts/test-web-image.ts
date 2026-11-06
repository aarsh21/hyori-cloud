import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const image = process.argv[2];

if (!image) throw new Error("Pass a locally built frontend Docker image.");

const name = `hyori-web-package-${randomBytes(8).toString("hex")}`;
const origin = "https://cloud.example.test";
const backendUrl = "http://127.0.0.1:9";
let created = false;

function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

try {
  assert.equal(docker(["image", "inspect", "--format", "{{.Config.User}}", image]), "node");
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-p",
    "127.0.0.1::3001",
    "-e",
    "APP_ENV=production",
    "-e",
    `APP_ORIGIN=${origin}`,
    "-e",
    `HYORI_BACKEND_URL=${backendUrl}`,
    image,
  ]);
  created = true;
  const address = docker(["port", name, "3001/tcp"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const url = `http://${address}`;
  const deadline = Date.now() + 60_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (docker(["inspect", "--format", "{{.State.Running}}", name]) !== "true") break;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const html = await response.text();

      if (response.ok) {
        assert.equal(html.includes("HYORI_BACKEND_URL"), false);
        assert.equal(html.includes(backendUrl), false);
        ready = true;
        break;
      }
    } catch {
      // The standalone runtime resolves its schema before binding and rendering the real page.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(ready, `Standalone web image did not render HTTP 200.\n${docker(["logs", name])}`);
  assert.equal(docker(["exec", name, "id", "-u"]), "1000");

  const response = await fetch(`${url}/api/rpc`, {
    method: "POST",
    headers: { Host: new URL(origin).host, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "auth.status", input: {} }),
  });

  assert.equal(response.status, 503);
  assert.match(await response.text(), /service\.unavailable/);
  docker([
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { existsSync, readdirSync } from 'node:fs';
    assert.deepEqual(readdirSync('/app').sort(), ['.env.schema', '.output', 'node_modules']);
    assert.deepEqual(readdirSync('/app/node_modules').sort(), ['.bin', 'react', 'varlock']);
    for (const file of ['/app/.env', '/app/.env.production', '/app/production.env', '/app/src'])
      assert.equal(existsSync(file), false);
  `,
  ]);
  console.log(
    "PASS minimal web image: real standalone SSR 200, nonroot UID1000, read-only/capability-dropped root, unavailable-backend503, private URL absent from HTML, bounded Varlock/React runtime only, no actual env files or workspace/source writes. This is packaging evidence, not a live Rust/browser deployment.",
  );
} finally {
  if (created) docker(["rm", "--force", name]);
}

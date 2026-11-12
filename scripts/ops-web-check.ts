// Exercise the actual built Node host, including SSR, denied proxy requests and static assets.
// bun scripts/ops-web-check.ts <container-name> <loopback-web-url> <public-origin>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [container, url, origin] = process.argv.slice(2);

if (!container || !url || !origin)
  throw new Error("Pass container, loopback web URL and public origin.");

const since = new Date().toISOString();

const asset = execFileSync(
  "docker",
  [
    "exec",
    container,
    "node",
    "-e",
    "console.log(require('node:fs').readdirSync('/app/.output/public/assets').find(name=>name.endsWith('.js')))",
  ],
  { encoding: "utf8" },
).trim();

const requests = [
  { path: "/share/known-share-secret", method: "GET", route: "page" },
  { path: "/assets/known-file-name.txt", method: "GET", route: "asset" },
  { path: "/api/storage/files/known-private-file.txt", method: "GET", route: "storage" },
  { path: "/api/rpc", method: "POST", route: "rpc" },
  { path: `/assets/${asset}`, method: "GET", route: "asset" },
];

const statuses = [];

for (const entry of requests) {
  const response = await fetch(`${url}${entry.path}?token=known-query-secret`, {
    method: entry.method,
    redirect: "manual",
    headers: {
      Host: new URL(origin).host,
      Origin: origin,
      Cookie: "hyori_session=known-cookie-secret; hyori_share=known-share-cookie",
      Authorization: "Bearer known-auth-secret",
      "Content-Type": "application/json",
    },
    body:
      entry.method === "POST"
        ? JSON.stringify({ operation: "known-body-secret", input: {} })
        : undefined,
  });

  await response.arrayBuffer();
  statuses.push(response.status);
}

await Bun.sleep(200);

const output = execFileSync("docker", ["logs", "--since", since, container], { encoding: "utf8" });

assert.doesNotMatch(output, /known-/);

const records = output
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.event === "web_request" && entry.route !== "health");

assert.equal(
  records.length,
  requests.length,
  `Expected one log per request, got ${records.length}`,
);

for (const [index, entry] of requests.entries()) {
  const record = records[index];
  assert.equal(record.method, entry.method);
  assert.equal(record.route, entry.route);
  assert.equal(record.status, statuses[index]);
  assert.ok(Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
  assert.deepEqual(Object.keys(record).sort(), [
    "duration_ms",
    "event",
    "method",
    "route",
    "status",
  ]);
}

console.log(
  "PASS actual web host: 5 requests, exactly 5 access records; SSR/static assets/proxy; correct status and duration; no known cookie/auth/share/query/body/file-name secrets",
);

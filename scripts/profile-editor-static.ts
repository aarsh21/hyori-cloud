import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { chromium } from "playwright-core";
import type { BrowserContext } from "playwright-core";
import { chromiumTrustFor } from "./browser-fixtures/web-host.ts";

const [, , originArgument, assetPath, caFile, destination] = process.argv;

if (!originArgument || !assetPath || !caFile || !destination || process.argv.length !== 6)
  throw new Error(
    "Usage: bun scripts/profile-editor-static.ts HTTPS_ORIGIN /artcraft/HASHED_ASSET PUBLIC_CA REPORT",
  );

const origin = new URL(originArgument);

assert.equal(origin.origin, originArgument);

assert.equal(origin.protocol, "https:");

assert.match(
  assetPath,
  /^\/artcraft\/(wordcraft|gridcraft|pdfcraft|deckcraft)\/[^/]+\/[^/]+-[0-9a-f]{15,20}(_bg)?\.(js|wasm)$/,
);

const assetUrl = new URL(assetPath, origin).href;

assert.equal(new URL(assetUrl).pathname, assetPath);

const hostname = origin.hostname.replace(/^\[|\]$/g, "");
const verification = isIP(hostname) ? "-verify_ip" : "-verify_hostname";

// Verify against the supplied public CA before pinning only that verified leaf key in Chromium.
const certificateText = execFileSync(
  "openssl",
  [
    "s_client",
    "-connect",
    `${origin.hostname}:${origin.port || "443"}`,
    "-servername",
    origin.hostname,
    "-verify_return_error",
    verification,
    hostname,
    "-CAfile",
    caFile,
    "-showcerts",
  ],
  { encoding: "utf8", input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
);

const leaf = certificateText.match(
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
)?.[0];

assert.ok(leaf, "Verified handshake returned no leaf certificate");

const certificate = new X509Certificate(leaf);
const profileDirectory = await mkdtemp(join(tmpdir(), "hyori-static-browser-profile-"));
let context: BrowserContext | undefined;

try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: true,
    serviceWorkers: "block",
    args: [chromiumTrustFor(leaf)],
  });
  const browser = context.browser();
  assert.ok(browser);
  const page = await context.newPage();
  // Routing would disable Playwright's HTTP cache and invalidate this observation.
  const probeUrl = new URL("/artcraft/legal/RUNTIME-NOTICE-INDEX.md", origin).href;
  const navigation = await page.goto(probeUrl);
  assert.equal(navigation?.status(), 200);

  const observations = await page.evaluate(async (url) => {
    performance.clearResourceTimings();
    const responses = [];

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

      if (!response.body) throw new Error("Static response has no body");
      const reader = response.body.getReader();
      let decodedBytes = 0;

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) break;
          decodedBytes += chunk.value.byteLength;

          if (decodedBytes > 128 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("Static response exceeded verified asset ceiling");
          }
        }
      } finally {
        reader.releaseLock();
      }

      responses.push({
        status: response.status,
        decodedBytes,
        cacheControl: response.headers.get("cache-control"),
        contentEncoding: response.headers.get("content-encoding"),
      });
    }

    return {
      responses,
      resources: performance
        .getEntriesByName(url)
        .filter((entry): entry is PerformanceResourceTiming => entry.entryType === "resource")
        .map((entry) => ({
          durationMs: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        })),
    };
  }, assetUrl);

  assert.equal(observations.responses.length, 2);
  assert.equal(observations.resources.length, 2);
  assert.ok(observations.responses.every((response) => response.status === 200));
  assert.equal(observations.responses[0]!.decodedBytes, observations.responses[1]!.decodedBytes);

  const report = {
    kind: "isolated-browser-static-cache-probe",
    origin: origin.origin,
    assetPath,
    browser: browser.version(),
    verifiedLeafSha256: createHash("sha256").update(certificate.raw).digest("hex"),
    profile:
      "fresh temporary persistent browser profile with default disk cache; no routing interception/cache override/cookies/accounts/service workers; public plain-text notice page, one asset twice with default fetch cache policy; TLS connection already established by notice navigation",
    observations,
    limits:
      "Public static delivery only. Plain-text public notices supply same-origin context without loading app scripts or private data. Asset is fetched but not imported/compiled/executed. No engine parsing, document first-input, save latency, physical-client network or capacity claim.",
  };

  await writeFile(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(
    `Public browser cache observation retained at ${destination}; no editor lifecycle speed claim.`,
  );
} finally {
  try {
    await context?.close();
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

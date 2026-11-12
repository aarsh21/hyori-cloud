import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { NATIVE_HOST_PROTOCOL } from "@hyori-cloud/client-sdk/editor-runtime";
import { createFrontHandler } from "../front-proxy.ts";
import type {} from "./host-entry.ts";
import type { ProbeReport, Reach } from "./synthetic-editor.ts";

/**
 * Compromised editor code in the real frame, behind the real gateway headers and the host's own
 * page policy: it may have the one document the bridge hands it and save through the bridge, and
 * nothing else of the person's. Synthetic engine, real Chromium, real SDK session and attachment.
 *
 *   bun test scripts/browser-fixtures/editor-probe/isolation.test.ts
 */
const VERSION = "0.14.0-isolation.1";
const ASSET = `/artcraft/wordcraft/${VERSION}`;
const SOURCE = [104, 121, 111, 114, 105];
const SESSION = "hyori_session=person-session";

type Request = { path: string; host: string; session: boolean };

const requests: Request[] = [];

/** Every request the gateway saw: the host it was addressed to, its path and its Origin. */
const gatewayRequests: { host: string; path: string; origin: string | null }[] = [];
const reports: ProbeReport[] = [];
const work = mkdtempSync(join(tmpdir(), "hyori-editor-isolation-"));
let browser: Browser;
let app: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.serve>;

/** A real engine: (module (func (export "answer") (result i32) i32.const 42)). */
const WASM = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119,
  101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
]);

const ENGINE = {
  url: `${ASSET}/synthetic_bg.wasm`,
  sha256: createHash("sha256").update(WASM).digest("hex"),
  bytes: WASM.byteLength,
};

/** Trunk's loader shape: one inline module that imports the hashed glue and starts it. */
function writeSyntheticBundle(engine: string) {
  const glue = `synthetic-${createHash("sha256").update(engine).digest("hex").slice(0, 16)}.js`;
  const directory = join(work, "bundle", "wordcraft", VERSION);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, glue), engine);
  writeFileSync(join(directory, "synthetic_bg.wasm"), WASM);
  writeFileSync(
    join(directory, "index.html"),
    `<!doctype html><title>Synthetic editor</title><script type="module">import "${ASSET}/${glue}";</script>`,
  );
  writeFileSync(
    join(work, "bundle", "runtime-bundle-manifest.json"),
    JSON.stringify({
      editors: [
        { app: "wordcraft", version: VERSION, assetUrl: `${ASSET}/index.html?host=parent` },
      ],
    }),
  );
}

// The web host's page policy (apps/web/src/start.ts): the frame may only ever hold this origin.
function hostPolicy(nonce: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

beforeAll(async () => {
  const [engine, host] = await Promise.all(
    [
      "scripts/browser-fixtures/editor-probe/synthetic-editor.ts",
      "scripts/browser-fixtures/editor-probe/host-entry.ts",
    ].map(async (entry) => {
      const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });

      if (!built.success) throw new Error(built.logs.join("\n"));

      return built.outputs[0]!.text();
    }),
  );

  writeSyntheticBundle(engine!);

  // Stands in for the Hyori web host and API: it answers only the person's session.
  app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const session = request.headers.get("cookie")?.includes(SESSION) === true;
      requests.push({ path: url.pathname, host: request.headers.get("host") ?? "", session });

      if (url.pathname === "/report") {
        reports.push(JSON.parse(await request.text()));

        return new Response(null, { status: 204 });
      }

      if (url.pathname.startsWith("/api/"))
        return session
          ? new Response(`secret of ${url.pathname}`)
          : new Response("signed out", { status: 401 });

      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      const nonce = crypto.randomUUID();

      return new Response(
        `<!doctype html><title>Hyori parent secret</title><script type="module" nonce="${nonce}">${host}</script>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": hostPolicy(nonce),
            "set-cookie": `${SESSION}; Path=/; HttpOnly; SameSite=Strict`,
          },
        },
      );
    },
  });

  const front = createFrontHandler({
    nitroUrl: `http://127.0.0.1:${app.port}`,
    staticRoot: join(work, "bundle"),
  });

  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { host, pathname } = new URL(request.url);

      gatewayRequests.push({ host, path: pathname, origin: request.headers.get("origin") });

      return front.handle(request, "http/1.1");
    },
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HYORI_CHROMIUM_PATH,
    timeout: 60_000,
  });
});

afterAll(async () => {
  await browser?.close();
  gateway?.stop(true);
  app?.stop(true);
  rmSync(work, { recursive: true, force: true });
});

test("compromised code in the editor frame reaches only what the bridge hands it", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const popups: string[] = [];

  context.on("page", (popup) => popups.push(popup.url()));
  const origin = `http://127.0.0.1:${gateway.port}`;

  await page.goto(`${origin}/`);
  await page.evaluate(() => localStorage.setItem("hyori-secret", "parent storage"));
  // The person is signed in: the parent's own request carries the session.
  expect(
    await page.evaluate(() => fetch("/api/rpc", { method: "POST" }).then((r) => r.text())),
  ).toBe("secret of /api/rpc");

  await page.evaluate(
    ({ asset, version, protocol, source, engine }) => {
      window.probe = window.startEditorProbe(
        {
          app: "wordcraft",
          bridge: `hyori-correlated-host-v${protocol}`,
          protocol,
          sessionId: "isolation",
          version,
          assetUrl: `${asset}/index.html?host=parent`,
          name: "Report.docx",
          revision: "1",
          writable: true,
          replacementName: "Report.docx",
          maxBytes: 1024,
          outputFormats: [{ extension: ".docx", kind: "document" }],
          engine,
        },
        source,
      );
    },
    {
      asset: ASSET,
      version: VERSION,
      protocol: NATIVE_HOST_PROTOCOL,
      source: SOURCE,
      engine: ENGINE,
    },
  );

  // Reported to the server, so the result survives whatever the frame does to the page.
  const first = await waitForReport("first");

  // The bridge's deliberate offer: the verified engine, fetched once by the host itself (no
  // opaque Origin), exactly the opened document, and a durable save of the edit.
  expect(first.engine).toBe("42");
  expect(
    gatewayRequests.flatMap(({ path, origin }) => (path === ENGINE.url ? [origin] : [])),
  ).toEqual([null]);
  expect(first.extraEngines).toBe(0);
  expect(first.received).toEqual(SOURCE);
  expect(first.autosaved).toBe(true);

  // Nothing else of the person's: not the host page, its storage, cookies or authority.
  for (const reach of [
    "parentDocument",
    "parentStorage",
    "storage",
    "indexedDb",
    "cookie",
    "rpc",
    "storageDownload",
    "topNavigation",
    "printHtml",
    "printSvg",
  ] satisfies Reach[])
    expect({ reach, outcome: first[reach] }).toMatchObject({ reach, outcome: { reached: false } });

  const fromFrame = requests.filter(({ path }) => path.startsWith("/api/"));
  expect(fromFrame.map(({ path }) => path)).toEqual(
    expect.arrayContaining(["/api/rpc", "/api/storage/files/secret"]),
  );
  // The parent's own check above is the only request that carried the session.
  expect(fromFrame.filter(({ session }) => session)).toHaveLength(1);
  expect(page.url()).toBe(`${origin}/`);
  expect(requests.some(({ path }) => path === "/top-navigated")).toBe(false);
  expect(await page.evaluate(() => window.probe.saves)).toEqual([
    { name: "Report.docx", intent: "replace", bytes: [...SOURCE, 33] },
  ]);

  // A real PDF prints in its own tab, which keeps the frame's opaque origin, never Hyori's.
  expect(first.printPdf).toEqual({ reached: true, value: "opened" });

  for (let waited = 0; popups.length === 0 && waited < 5000; waited += 100) await Bun.sleep(100);
  expect(popups).toHaveLength(1);
  expect(popups[0]).toStartWith("blob:null/");

  // A frame that navigates itself away gets no second copy of the document.
  const reloaded = await waitForReport("reloaded");
  expect(reloaded.prepared).toBe("ready");
  expect(reloaded.received).toBeUndefined();
  expect(reloaded.engine).toBeUndefined();
  expect(await page.evaluate(() => window.probe.status())).toBe("failed");

  // Nor can it take the frame to another origin: the host page allows only its own in frames.
  await Bun.sleep(1500);
  expect(gatewayRequests.filter(({ host }) => !host.startsWith("127.0.0.1:"))).toEqual([]);
  expect(reports.some(({ visit }) => visit === "elsewhere")).toBe(false);

  await context.close();
}, 60_000);

async function waitForReport(visit: string) {
  for (let waited = 0; waited < 15_000; waited += 100) {
    const found = reports.find((report) => report.visit === visit);

    if (found !== undefined) return found;
    await Bun.sleep(100);
  }

  throw new Error(`The ${visit} frame never reported: ${JSON.stringify(reports)}`);
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, join } from "node:path";
import { chromium } from "playwright-core";
import { syntheticDeckCraft } from "./deckcraft-synthetic.ts";
import { sha256 } from "./evidence-bytes.ts";
import { checkRuntimeBundle } from "./content-runtime.ts";
import handoff from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };

function syntheticPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];

  let body = "%PDF-1.7\n";
  const offsets = [0];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = Buffer.byteLength(body);
  body += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(body);
}

const [, , rootArgument, browserPath, outputArgument] = process.argv;

if (!rootArgument || !browserPath || !outputArgument || process.argv.length !== 5)
  throw new Error(
    "Usage: bun scripts/artcraft/engine-capability-probe.ts EXISTING_RUNTIME INSTALLED_CHROMIUM NEW_EVIDENCE",
  );

const root = resolve(rootArgument);
const output = resolve(outputArgument);

const verifiedRuntime = await checkRuntimeBundle(root, handoff.manifestSha256);

await mkdir(output);

const apps = [
  {
    app: "wordcraft",
    version: "0.14.0",
    name: "Synthetic.rtf",
    bytes: Buffer.from("{\\rtf1\\ansi Synthetic native save probe.}"),
  },
  {
    app: "gridcraft",
    version: "0.15.0",
    name: "Synthetic.csv",
    bytes: Buffer.from("Name,Value\nSynthetic,42\n"),
  },
  { app: "pdfcraft", version: "0.17.0", name: "Synthetic.pdf", bytes: syntheticPdf() },
  {
    app: "deckcraft",
    version: "0.14.1-hyori-host.2",
    name: "Synthetic.deckcraft",
    bytes: syntheticDeckCraft(),
  },
];

const html = `<!doctype html><meta charset="utf-8"><title>Native engine capability probe</title><style>iframe{width:1200px;height:800px;border:0}</style><input id="parent-input" aria-label="Parent focus control"><iframe sandbox="allow-scripts allow-same-origin" title="Synthetic document"></iframe><script>
window.probe={messages:[],saves:[]};
addEventListener('message',async event=>{
 const frame=document.querySelector('iframe');
 if(event.origin!==location.origin||event.source!==frame.contentWindow)return;
 const data=event.data;
 if(!data||typeof data.type!=='string')return;
 const copy={...data};delete copy.bytes;
 window.probe.messages.push(copy);
 if(data.bytes instanceof ArrayBuffer||data.bytes instanceof Uint8Array){
 const bytes=new Uint8Array(data.bytes);
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 window.probe.saves.push({...copy,bytes:bytes.length,sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join(''),prefix:Array.from(bytes.slice(0,16))});
 if(data.type==='deckcraft:save')frame.contentWindow.postMessage({type:'deckcraft:save-result',protocol:1,version:'0.14.1-hyori-host.2',saveId:data.saveId,status:'saved',revision:'synthetic-ack'},location.origin);
 }
});</script>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);

    if (pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    const file = resolve(root, `.${pathname}`);

    if (!file.startsWith(`${root}${sep}`)) return new Response(null, { status: 404 });
    const body = Bun.file(file);

    if (!(await body.exists())) return new Response(null, { status: 404 });

    return new Response(body, {
      headers: { "content-type": file.endsWith(".wasm") ? "application/wasm" : body.type },
    });
  },
});

const browserHome = await mkdtemp(join(tmpdir(), "hyori-capability-browser-"));

const browser = await chromium
  .launch({
    env: {
      PATH: "/usr/bin:/bin",
      HOME: browserHome,
      LANG: "C.UTF-8",
      XDG_CONFIG_HOME: join(browserHome, "config"),
      XDG_CACHE_HOME: join(browserHome, "cache"),
    },
    executablePath: browserPath,
    headless: true,
    chromiumSandbox: true,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  })
  .catch(async (cause) => {
    await server.stop(true);
    await rm(browserHome, { recursive: true, force: true });
    throw cause;
  });

const results = [];

try {
  for (const app of apps) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      colorScheme: "light",
      acceptDownloads: false,
    });

    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === server.url.origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.origin);
    await page
      .locator("iframe")
      .evaluate(
        (element, path) => element.setAttribute("src", path),
        `/${app.app}/${app.version}/index.html?host=parent&webgl`,
      );
    await page.waitForFunction(
      (type) => window.probe.messages.some((message) => message.type === type),
      `${app.app}:ready`,
      { timeout: 120000 },
    );
    const frame = page.frames().find((frame) => frame !== page.mainFrame());

    if (!frame) throw new Error("Engine iframe missing");
    await page.evaluate(
      ({ app, bytes }) => {
        const message = {
          type: `${app.app}:open`,
          name: app.name,
          bytes: new Uint8Array(bytes),
        };

        if (app.app === "deckcraft")
          Object.assign(message, {
            protocol: 1,
            version: app.version,
            openId: "synthetic-open",
            writable: true,
            maxBytes: 67108864,
            replacementName: app.name,
            outputFormats: [{ extension: ".deckcraft", kind: "document" }],
          });
        document.querySelector("iframe")!.contentWindow!.postMessage(message, location.origin);
      },
      { app: { app: app.app, name: app.name, version: app.version }, bytes: [...app.bytes] },
    );

    if (app.app === "deckcraft")
      await page.waitForFunction(() =>
        window.probe.messages.some((message) => message.type === "deckcraft:opened"),
      );
    // Official engines have no parsed acknowledgement: this delay is observation only, never readiness proof.
    await page.waitForTimeout(2500);
    const attempts = [];

    for (const focus of ["parent", "editor"] as const) {
      if (focus === "parent") await page.locator("#parent-input").click();
      else await frame.locator("canvas").click({ position: { x: 650, y: 450 } });
      await page.waitForTimeout(150);

      for (const target of ["window", "document", "canvas", "textarea"] as const) {
        const before = await page.evaluate(() => window.probe.saves.length);

        const state = await frame.evaluate((target) => {
          const active = document.activeElement;
          let node: EventTarget | null = document.querySelector(target);

          if (target === "window") node = window;

          if (target === "document") node = document;

          if (!node)
            return {
              available: false,
              trusted: null,
              focusUnchanged: true,
              documentFocused: document.hasFocus(),
            };

          const down = new KeyboardEvent("keydown", {
            key: "s",
            code: "KeyS",
            keyCode: 83,
            which: 83,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          });

          node.dispatchEvent(down);
          node.dispatchEvent(
            new KeyboardEvent("keyup", {
              key: "s",
              code: "KeyS",
              keyCode: 83,
              which: 83,
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );

          return {
            available: true,
            trusted: down.isTrusted,
            focusUnchanged: active === document.activeElement,
            documentFocused: document.hasFocus(),
          };
        }, target);

        await page.waitForTimeout(700);
        const after = await page.evaluate(() => window.probe.saves.length);
        attempts.push({ focus, target, ...state, nativeSaveEvents: after - before });
      }
    }

    const before = await page.evaluate(() => window.probe.saves.length);
    await frame.locator("canvas").click({ position: { x: 650, y: 450 } });
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => window.probe.saves.length);
    const observed = await page.evaluate(() => window.probe);

    const wasm = await frame.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.endsWith(".wasm"))
        .map((entry) => ({ url: entry.name, durationMs: entry.duration })),
    );

    results.push({
      app: app.app,
      version: app.version,
      inputSha256: sha256(app.bytes),
      attempts,
      trustedControlNativeSaves: after - before,
      observed,
      errors,
      wasm,
    });
    await writeFile(
      join(output, `${app.app}.json`),
      `${JSON.stringify(results.at(-1), null, 2)}\n`,
      { flag: "wx" },
    );
    await context.close();
  }

  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify(
      {
        browser: browser.version(),
        runtimeManifestSha256: verifiedRuntime.manifestSha256,
        syntheticOnly: true,
        sandboxEnabled: true,
        isolatedBrowserEnvironment: true,
        focusStealingInDispatch: false,
        actualHttpPerformanceBaseline: false,
        results,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      results.map((result) => ({
        app: result.app,
        attempts: result.attempts,
        trustedControlNativeSaves: result.trustedControlNativeSaves,
        errors: result.errors,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.stop(true);
  await rm(browserHome, { recursive: true, force: true });
}

declare global {
  interface Window {
    probe: {
      messages: { type: string }[];
      saves: { type: string; bytes: number; sha256: string }[];
    };
  }
}

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { chromium } from "playwright-core";
import { EDITOR_RENDERING_ARGS } from "../web-host.ts";
import { createEditorCases } from "./cases.ts";
import type { EditorApp, EditorCase } from "./cases.ts";
import type {} from "./host-entry.ts";

/**
 * Real Chromium, real editor bundles, the real SDK session and the real frame attachment, with
 * storage held in the page. It proves the frame layer only: never persistence, never a release
 * asset gate, and never a claim about format fidelity.
 *
 *   bun scripts/browser-fixtures/editor-probe/run.ts OFFICIAL_BUNDLES DECK_BUNDLE NEW_EVIDENCE_DIR
 */
const [, , officialArgument, deckArgument, outputArgument] = process.argv;

if (officialArgument === undefined || deckArgument === undefined || outputArgument === undefined) {
  throw new Error("Usage: run.ts OFFICIAL_BUNDLES DECK_BUNDLE NEW_EVIDENCE_DIR");
}

const official = resolve(officialArgument);
const deck = resolve(deckArgument);
const output = resolve(outputArgument);
const work = mkdtempSync(join(tmpdir(), "hyori-editor-probe-"));

mkdirSync(output);

const built = await Bun.build({
  entrypoints: ["scripts/browser-fixtures/editor-probe/host-entry.ts"],
  target: "browser",
});

const hostScript = await built.outputs[0]?.text();

if (hostScript === undefined) throw new Error("The probe host didn't build.");

const MIME = new Map([
  [".wasm", "application/wasm"],
  [".js", "text/javascript"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".ico", "image/x-icon"],
]);

const ROOTS = new Map([
  ["/artcraft/wordcraft/0.14.0/", join(official, "wordcraft/0.14.0")],
  ["/artcraft/gridcraft/0.15.0/", join(official, "gridcraft/0.15.0")],
  ["/artcraft/pdfcraft/0.17.0/", join(official, "pdfcraft/0.17.0")],
  ["/artcraft/deckcraft/0.14.1-hyori-host.1/", deck],
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      return new Response(`<!doctype html><title>probe</title><script>${hostScript}</script>`, {
        headers: { "content-type": "text/html" },
      });
    }

    for (const [prefix, root] of ROOTS) {
      if (!pathname.startsWith(prefix)) continue;

      const path = resolve(join(root, pathname.slice(prefix.length)));

      if (!path.startsWith(root)) break;

      try {
        if (!statSync(path).isFile()) break;
      } catch {
        break;
      }

      return new Response(readFileSync(path), {
        headers: {
          "content-type": MIME.get(extname(path)) ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

const MARKER = "HYORIPROBE";
const ONLY = process.env.EDITOR_PROBE_ONLY;
const cases = createEditorCases(work);

type Case = {
  readonly item: EditorCase;
  readonly version: string;
  readonly name: string;
  readonly formats: readonly { extension: string; kind: "document" | "export" }[];
  readonly replacementName?: string | null;
};

const DECK_VERSION = "0.14.1-hyori-host.2";

const CASES: readonly Case[] = [
  {
    item: cases.word,
    version: "0.14.0",
    name: "probe.docx",
    formats: [{ extension: ".docx", kind: "document" }],
  },
  {
    item: cases.deckFromPptx,
    version: DECK_VERSION,
    name: "probe.pptx",
    formats: [{ extension: ".deckcraft", kind: "document" }],
    replacementName: null,
  },
  {
    item: cases.grid,
    version: "0.15.0",
    name: "probe.xlsx",
    formats: [{ extension: ".xlsx", kind: "document" }],
  },
  {
    item: cases.deck,
    version: DECK_VERSION,
    name: "probe.deckcraft",
    formats: [{ extension: ".deckcraft", kind: "document" }],
  },
  {
    item: cases.pdf,
    version: "0.17.0",
    name: "probe.pdf",
    formats: [{ extension: ".pdf", kind: "document" }],
  },
];

const browser = await chromium.launch({
  headless: true,
  args: [...EDITOR_RENDERING_ARGS],
  timeout: 60_000,
});

type ProbeState = {
  readonly status: string;
  readonly unsaved: boolean;
  readonly message: string | null;
  readonly guardHeld: boolean;
  readonly windowIsStable: boolean;
  readonly saves: readonly { name: string; intent: string; size: number }[];
};

type ProbeResult = {
  app: EditorApp;
  version: string;
  openMs?: number;
  opened?: ProbeState;
  afterEdit?: ProbeState;
  afterSave?: ProbeState;
  freshReopen?: ProbeState;
  saveProduced?: boolean;
  changedFromOriginal?: boolean;
  savedSha256?: string;
  containsEdit?: string;
  error?: string;
  pageErrors?: readonly string[];
};

const results: ProbeResult[] = [];

async function open(
  page: Page,
  { item: { app }, version, name, formats, replacementName }: Case,
  bytes: Buffer,
) {
  await page.evaluate(
    ({ descriptor, source }) => {
      window.probe = window.startEditorProbe(descriptor, source);
    },
    {
      descriptor: {
        sessionId: `session_${app}`,
        app,
        version,
        name,
        revision: "1",
        writable: true,
        maxBytes: 32 * 1024 * 1024,
        replacementName: replacementName === undefined ? name : replacementName,
        outputFormats: formats,
        assetUrl: `/artcraft/${app}/${version}/index.html?host=parent`,
      },
      source: [...bytes],
    },
  );

  await page.waitForFunction(
    () => ["editing", "failed"].includes(window.probe.status()),
    undefined,
    {
      timeout: 180_000,
    },
  );
}

const state = (page: Page): Promise<ProbeState> =>
  page.evaluate(() => {
    const { probe } = window;

    return {
      status: probe.status(),
      unsaved: probe.unsaved(),
      message: probe.message(),
      guardHeld: probe.guardHeld(),
      windowIsStable: probe.windowIsStable(),
      saves: probe.saves.map(({ name, intent, bytes }) => ({ name, intent, size: bytes.length })),
    };
  });

try {
  for (const probe of CASES.filter(
    ({ name }) => ONLY === undefined || ONLY.split(",").includes(name),
  )) {
    const { item, name, version } = probe;
    const sourceBytes = readFileSync(item.source);
    const startedAt = Date.now();

    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 800 } })
    ).newPage();

    const problems: string[] = [];

    page.on("pageerror", (error) => problems.push(error.message.slice(0, 200)));

    const result: ProbeResult = { app: item.app, version };

    results.push(result);

    try {
      await page.goto(server.url.href);
      await open(page, probe, sourceBytes);
      result.openMs = Date.now() - startedAt;
      result.opened = await state(page);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: join(output, `${name}-opened.png`) });

      await item.edit(page, 0, MARKER);
      result.afterEdit = await state(page);
      await page.screenshot({ path: join(output, `${name}-edited.png`) });

      await page.keyboard.press("Control+s");
      await page
        .waitForFunction(() => window.probe.saves.length > 0, undefined, { timeout: 20_000 })
        .catch(() => undefined);

      await page.waitForTimeout(1000);
      await page.screenshot({ path: join(output, `${name}-after-save.png`) });
      result.afterSave = await state(page);

      const saved = await page.evaluate(() => window.probe.saves.at(-1)?.bytes ?? null);

      if (saved === null) {
        result.saveProduced = false;
      } else {
        const bytes = Buffer.from(saved);

        result.saveProduced = true;
        result.changedFromOriginal = !bytes.equals(sourceBytes);
        result.savedSha256 = createHash("sha256").update(bytes).digest("hex");
        result.containsEdit = item.contains(bytes, MARKER) ? "yes" : "no";
        writeFileSync(join(output, `${name}-saved`), bytes);

        await page.evaluate(() => window.probe.dispose());
        await open(page, probe, bytes);
        result.freshReopen = await state(page);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(output, `${name}-reopened.png`) });
      }
    } catch (error) {
      result.error = String(error).slice(0, 400);
      await page
        .screenshot({ path: join(output, `${item.app}-failed.png`) })
        .catch(() => undefined);
    }

    result.pageErrors = problems.slice(0, 5);
    console.log(JSON.stringify(result));
    await page.context().close();
  }
} finally {
  writeFileSync(
    join(output, "probe-result.json"),
    JSON.stringify(
      {
        caveat:
          "Frame layer only: real Chromium, real bundles and the real SDK session, with storage held in the page.",
        results,
      },
      null,
      2,
    ),
  );
  await browser.close();
  void server.stop(true);
  rmSync(work, { recursive: true, force: true });
}

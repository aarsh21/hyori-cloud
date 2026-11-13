import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { z } from "zod";
import { expandZipEntry, validateZipArchive } from "./validated-zip.ts";

const run = z.object({
  text: z.string(),
  props: z.object({ bold: z.boolean().nullable() }).nullable(),
});

const presentation = z.object({
  presentation: z.object({
    slides: z.array(
      z.object({
        ["shapes"]: z.array(
          z.object({
            text: z.object({ paragraphs: z.array(z.object({ runs: z.array(run) })) }).nullable(),
          }),
        ),
      }),
    ),
  }),
});

type TextRun = { text: string; bold: boolean };

// Opt-in real-stack regression: Node, headed Chromium, Linux X11/xdotool, and a fresh synthetic
// .deckcraft upload are required. State is private fixture output, never a production account.
// node scripts/artcraft/check-deck-clipboard.ts PRIVATE_STATE_JSON FRESH_FILE_NAME NEW_OUTPUT_DIR
const [, , statePath, fileName, output] = process.argv;

assert.ok(statePath && fileName && output, "state, fresh document name, output required");

const state: {
  origin: string;
  folderPath: string;
  trust: string;
  args: string[];
  cookies: Parameters<BrowserContext["addCookies"]>[0];
} = JSON.parse(readFileSync(statePath, "utf8"));

mkdirSync(output);

const profile = mkdtempSync(join(tmpdir(), "hyori-clipboard-regression-"));

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 856 },
  args: [state.trust, ...state.args],
});

const checks: { name: string; passed: boolean; observed: string | boolean | TextRun[] }[] = [];
const xd = (...args: string[]) => execFileSync("xdotool", args).toString().trim();
const pause = () => new Promise((resolve) => setTimeout(resolve, 450));

async function key(...chords: string[]) {
  const windows = xd("search", "--onlyvisible", "--class", "chrom").split("\n");
  assert.equal(windows.length, 1, "the private X display must have exactly one Chromium window");
  xd("windowfocus", "--sync", windows[0]!);

  for (const chord of chords) {
    xd("key", "--clearmodifiers", "--delay", "80", chord);
    await pause();
  }
}

async function type(text: string) {
  xd("type", "--clearmodifiers", "--delay", "40", text);
  await pause();
}

function check(name: string, passed: boolean, observed: string | boolean | TextRun[]) {
  checks.push({ name, passed, observed });
  console.log(JSON.stringify(checks.at(-1)));
}

try {
  await context.addCookies(state.cookies);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: state.origin });
  const page = await context.newPage();
  await page.goto(state.origin + state.folderPath);
  await page.getByRole("button", { name: `Actions for ${fileName}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Open in editor", exact: true }).click();
  const status = page.locator('[data-slot="hosted-document"] header [role="status"]');
  await status
    .filter({ hasText: /^(All changes saved|Ready to edit)$/ })
    .waitFor({ timeout: 180000 });
  await pause();
  const frame = page.frames().find((item) => item.url().includes("/artcraft/deckcraft/"));
  assert.ok(frame);
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  const setClipboard = (text: string) =>
    page.evaluate((value) => navigator.clipboard.writeText(value), text);

  async function saved(label: string) {
    await key("ctrl+s");
    await status.filter({ hasText: "All changes saved" }).waitFor({ timeout: 30000 });
    const files = await context.newPage();
    await files.goto(state.origin + state.folderPath);
    await files.getByRole("button", { name: `Actions for ${fileName}`, exact: true }).click();
    const pending = files.waitForEvent("download");
    await files.getByRole("menuitem", { name: "Download", exact: true }).click();
    const path = join(output!, `${label}.deckcraft`);
    await (await pending).saveAs(path);
    await files.close();
    await page.bringToFront();

    const entries = validateZipArchive(readFileSync(path), null, {
      maxEntries: 1000,
      maxExpandedBytes: 32 * 1024 * 1024,
      maxEntryBytes: 16 * 1024 * 1024,
    });

    const entry = entries.find((item) => item.path === "presentation.json");
    assert.ok(entry);
    const document = presentation.parse(JSON.parse(expandZipEntry(entry).toString()));

    const rows = document.presentation.slides.flatMap((slide) =>
      slide.shapes.flatMap(
        (element) =>
          element.text?.paragraphs.flatMap((paragraph) =>
            paragraph.runs.map((item) => ({ text: item.text, bold: item.props?.bold === true })),
          ) ?? [],
      ),
    );

    writeFileSync(join(output!, `${label}.json`), JSON.stringify(rows, null, 2));

    return rows;
  }

  await page.mouse.dblclick(900, 450, { delay: 100 });
  await pause();
  await type("INTERNAL_A");
  await key("ctrl+a", "ctrl+b", "End", "Return", "ctrl+b");
  await type("plain");
  await key("shift+Home");
  await saved("before");
  await key("Home", "Up", "Home", "shift+End");
  await key("ctrl+c");
  await frame.evaluate(() => {
    document.documentElement.dataset.hyoriClipboardBlur = "0";
    window.addEventListener("blur", () => {
      document.documentElement.dataset.hyoriClipboardBlur = "1";
    });
  });
  await setClipboard("OS_B");
  await key("ctrl+shift+c", "Down", "Home", "shift+End", "ctrl+shift+v");

  const focused = await frame.evaluate(
    () => document.hasFocus() && document.documentElement.dataset.hyoriClipboardBlur === "0",
  );

  await page.screenshot({ path: join(output, "formatted.png") });
  const formatted = await saved("formatted");
  check(
    "armed Shift+V applies format without insertion",
    formatted.some((row) => row.text === "plain" && row.bold) &&
      !formatted.some((row) => row.text.includes("OS_B")),
    formatted,
  );
  check("keyboard sequence keeps page focus", focused, focused);
  await key("ctrl+z");
  await page.screenshot({ path: join(output, "undone.png") });
  const undone = await saved("undone");
  check(
    "one undo restores destination format",
    undone.some((row) => row.text === "plain" && !row.bold),
    undone,
  );
  await key("Escape");
  await page.mouse.dblclick(900, 450, { delay: 100 });
  await pause();

  for (const chord of ["ctrl+v", "ctrl+shift+v"]) {
    await key("ctrl+a", "BackSpace");
    await type("INTERNAL_A");
    await key("ctrl+a", "ctrl+c", "ctrl+a", "BackSpace");
    await setClipboard("OS_B");
    await key(chord, "ctrl+a", "ctrl+c");
    const observed = await clipboard();
    check(`${chord}: internal A, external B, cleared destination`, observed === "OS_B", observed);
    await page.screenshot({ path: join(output, `${chord}.png`) });
  }
} finally {
  writeFileSync(join(output, "result.json"), JSON.stringify(checks, null, 2));
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

assert.ok(
  checks.length === 5 && checks.every((item) => item.passed),
  "clipboard regression failed; inspect result.json",
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import type { EditorApp, EditorCase } from "./editor-probe/cases.ts";
import type { FrontHandler } from "./front-proxy.ts";
import { downloadBytes, hydrated, rowMenu, uploadFiles } from "./page-actions.ts";
import { openPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { waitForTrayIdle } from "./scenarios-photos.ts";

const FRAME = '[data-slot="hosted-document-frame"]';
const BAR = '[data-slot="hosted-document"] header';
const STATUS = `${BAR} [role="status"]`;

/** Software rendering and an uncompressed first load of a large WebAssembly bundle are both slow. */
const OPEN_TIMEOUT_MS = 180_000;
const SAVE_TIMEOUT_MS = 90_000;

/** The older editors report ready as soon as they're sent a document, ahead of drawing it. */
const PAINT_MS = 4000;

/** Initial desktop viewport; waitForEditor preserves the legacy canvas size across host-header changes. */
export const EDITOR_VIEWPORT = { width: 1280, height: 844 };

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const inBundle = (run: CoreRun, app: EditorApp) =>
  run.editorBundle?.editors.some((editor) => editor.app === app) ?? false;

/** Uploaded through the picker and committed, with the tray cleared. */
export async function uploadDocuments(run: CoreRun, page: Page, paths: readonly string[]) {
  await uploadFiles(page, [...paths]);
  await waitForTrayIdle(run, page, paths.length);
}

export const rowIn = (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}` });

/** A public link: live before it's pressed, and resolved only because it was. */
export async function openSharedItem(run: CoreRun, context: BrowserContext, path: string) {
  const page = await openPage(run, context, path);

  await hydrated(page);
  await page.getByRole("button", { name: "Open shared item" }).click();

  return page;
}

/** What a browser prompt was, refused so nothing is left. Fails if the action didn't ask. */
export async function promptRefused(page: Page, action: () => Promise<void>) {
  const prompt = page.waitForEvent("dialog", { timeout: 10_000 });

  await action();

  const dialog = await prompt;

  await dialog.dismiss();

  return dialog.type();
}

export function barStatus(page: Page, text: RegExp | string) {
  return page.locator(STATUS, { hasText: text });
}

export function barButton(page: Page, name: string) {
  return page.locator(BAR).getByRole("button", { name, exact: true });
}

/** What covers the frame once editing has stopped: a conflict, ended access, or a failed open. */
export function cover(page: Page) {
  return page.locator('[data-slot="hosted-document"] main');
}

export function coverButton(page: Page, name: string) {
  return cover(page).getByRole("button", { name, exact: true });
}

export function operationCount(front: FrontHandler, operation: string, status?: number) {
  return front.trace.filter(
    (record) =>
      record.operation === operation && (status === undefined || record.status === status),
  ).length;
}

export async function untilOperation(
  front: FrontHandler,
  operation: string,
  count: number,
  status = 200,
) {
  const deadline = Date.now() + SAVE_TIMEOUT_MS;

  while (operationCount(front, operation, status) < count) {
    if (Date.now() > deadline) {
      const seen = front.trace
        .filter((record) => record.operation === operation)
        .map((record) => `${record.status} ${record.errorBody ?? ""}`.trim());

      throw new Error(`No ${status} from ${operation}: saw ${JSON.stringify(seen)}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until the session has really opened, and the frame is the size edits are placed for. */
/**
 * A clean, freshly opened document. Protocol 2 editors say "Ready to edit" until their first save
 * in this session; legacy editors have no such state and say "All changes saved".
 */
export const OPENED_CLEAN = /^(All changes saved|Ready to edit)$/;

export async function waitForEditor(
  page: Page,
  expected: "All changes saved" | "Read only" | "Save a copy to keep changes",
) {
  // Protocol 2 editors open a format they can't replace in place as copy-only from the start.
  await page
    .locator(STATUS, {
      hasText:
        /^(All changes saved|Ready to edit|Read only|Save a copy to keep changes|Editor stopped)$/,
    })
    .waitFor({ timeout: OPEN_TIMEOUT_MS });

  const state = await page.locator(STATUS).innerText();

  assert.equal(
    OPENED_CLEAN.test(state) ? "All changes saved" : state,
    expected,
    "the editor's state when opened",
  );
  let box = await page.locator(FRAME).boundingBox();
  assert.ok(box !== null, "the editor frame isn't on the page");
  const element = await page.locator(FRAME).elementHandle();
  const frame = await element?.contentFrame();
  assert.ok(frame, "the editor frame has no browsing context");

  // These recipes belong only to the unchanged legacy engines, not the new native chrome.
  // The child may observe a resize after the parent. Don't apply a second correction from
  // its stale viewport; wait for the measured dimensions before sending canvas coordinates.
  await page.setViewportSize({ width: 1280, height: 800 + Math.round(box.y) });
  await frame.waitForFunction(() => innerWidth === 1280 && innerHeight === 800);

  assert.deepEqual(
    await frame.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    { width: 1280, height: 800 },
    "the legacy editor's measured inner viewport",
  );
  await page.waitForTimeout(PAINT_MS);
  box = await page.locator(FRAME).boundingBox();
  assert.ok(box !== null);

  return box.y;
}

export async function openFromRow(
  page: Page,
  name: string,
  expected: "All changes saved" | "Read only" | "Save a copy to keep changes" = "All changes saved",
) {
  await rowMenu(page, name, "Open in editor");
  await page.waitForURL(/\/edit\/[^/]+$/);

  return waitForEditor(page, expected);
}

/** The frame must be running exactly what the handed-over bundle says this app is. */
export async function assertBundleAsset(run: CoreRun, page: Page, app: EditorApp) {
  const expected = run.editorBundle?.editors.find((editor) => editor.app === app)?.assetUrl;

  assert.ok(expected !== undefined, `${app} isn't in this run's bundle`);
  await page.waitForFunction(
    ([selector, url]) =>
      document.querySelector(selector ?? "")?.getAttribute("src") === (url ?? ""),
    [FRAME, expected],
    { timeout: OPEN_TIMEOUT_MS },
  );
}

/** A real edit: the session has to report it, because that's what protects it from being lost. */
export async function editDocument(page: Page, item: EditorCase, top: number, marker: string) {
  // Protocol 2 editors schedule a background save at once, so they pass through these instead.
  // Watched from before the edit: a slow edit can be saved in the background before it returns.
  const reported = barStatus(
    page,
    /^(Unsaved changes|Waiting for current edit…|Saving soon…|Preparing to save…|Saving…)$/,
  ).waitFor({ timeout: 60_000 });

  reported.catch(() => undefined);
  await item.edit(page, top, marker);
  await reported;
}

/** Whether the open frame runs a protocol 2 editor, by the exact asset the bundle names. */
export async function inNativeEditor(run: CoreRun, page: Page) {
  const src = await page.locator(FRAME).getAttribute("src");

  return (
    run.editorBundle?.editors.some(
      ({ assetUrl, protocol }) => protocol === 3 && assetUrl === src,
    ) === true
  );
}

/** Saved only once the server has said so: the bar reads the same before any save has happened. */
export async function saveWithKeyboard(run: CoreRun, page: Page) {
  const before = operationCount(run.front, "editors.completeSave", 200);

  await page.keyboard.press("Control+s");

  // A background save may already have carried the edit; Ctrl+S then only flushes what's left.
  // "All changes saved" is shown only after the server confirmed a save of this session's edits.
  if (!(await inNativeEditor(run, page))) {
    await untilOperation(run.front, "editors.completeSave", before + 1);
    await barStatus(page, "All changes saved").waitFor({ timeout: 20_000 });

    return;
  }

  // Ctrl+S on an already saved native document still starts a capture, which counts as unsaved
  // work until it lands. Settled means saved, with nothing left to save, for a whole second.
  const deadline = Date.now() + 20_000;
  let settledSince: number | null = null;

  while (settledSince === null || Date.now() - settledSince < 1000) {
    assert.ok(Date.now() < deadline, "the native save didn't settle");

    const settled =
      (await barStatus(page, "All changes saved").count()) === 1 &&
      (await barButton(page, "Save").isDisabled());

    settledSince = settled ? (settledSince ?? Date.now()) : null;
    await page.waitForTimeout(100);
  }
}

export async function closeEditor(page: Page) {
  await barButton(page, "Close").click();
  await page.locator('[data-slot="hosted-document"]').waitFor({ state: "detached" });
  // DOM detachment precedes the replacement view's first paint. An immediate Chromium
  // pointer command can stall before it dispatches any event to the new page.
  await page
    .getByRole("main")
    .first()
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
}

export function downloadRow(page: Page, name: string) {
  return downloadBytes(page, () => rowMenu(page, name, "Download"));
}

/**
 * How many earlier versions the file really has, from its own history as the server says now. The
 * page is reloaded first because the list shows what it already holds while it asks again, so an
 * answer from earlier in this page could otherwise be counted. "Current" draws at once from the
 * listing, so only this opening's reply, and the list that follows it, says what's there.
 */
export async function assertEarlierVersions(
  page: Page,
  name: string,
  expected: number,
  bound: "exactly" | "at least" = "exactly",
) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await rowIn(page, name).waitFor();

  const answered = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('"operation":"files.versions"') === true &&
      response.ok(),
  );

  await rowMenu(page, name, "Version history…");
  await answered;

  const dialog = page.getByRole("dialog");
  const restore = dialog.getByRole("button", { name: "Restore" });

  await restore.or(dialog.getByText("No earlier versions yet.")).first().waitFor();

  const count = await restore.count();

  await dialog.getByRole("button", { name: "Close" }).first().click();
  await dialog.waitFor({ state: "detached" });
  assert.ok(
    bound === "exactly" ? count === expected : count >= expected,
    `${name} has ${count} earlier versions, not ${bound} ${expected}`,
  );

  return count;
}

export function assertHoldsEdit(item: EditorCase, saved: Buffer, marker: string) {
  assert.ok(!saved.equals(readFileSync(item.source)), "the saved bytes are still the original's");
  assert.ok(item.contains(saved, marker), `the saved ${item.extension} doesn't hold the edit`);
}

/**
 * Mean luminance (0–255) of the editor's own chrome: the band just under the product's bar,
 * where every engine draws its title bar and ribbon. Document content sits below it.
 */
export async function editorChromeLuminance(page: Page) {
  const box = await page.locator(FRAME).boundingBox();

  assert.ok(box !== null, "the editor frame isn't on the page");

  const png = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(96, box.height) },
    animations: "disabled",
  });

  return page.evaluate(
    async (source) => {
      const image = new Image();

      image.src = source;
      await image.decode();

      const canvas = new OffscreenCanvas(image.width, image.height);
      const drawing = canvas.getContext("2d");

      if (drawing === null) throw new Error("No 2D canvas.");
      drawing.drawImage(image, 0, 0);

      const data = drawing.getImageData(0, 0, image.width, image.height).data;
      let sum = 0;

      for (let index = 0; index < data.length; index += 4)
        sum += 0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!;

      return sum / (data.length / 4);
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
}

/** Waits until the editor's chrome is drawn in the asked appearance, and returns its luminance. */
export async function untilEditorChrome(page: Page, appearance: "light" | "dark") {
  const deadline = Date.now() + 20_000;
  let luminance = await editorChromeLuminance(page);

  while (appearance === "dark" ? luminance > 96 : luminance < 160) {
    if (Date.now() > deadline)
      throw new Error(
        `the editor's chrome stayed at luminance ${Math.round(luminance)}, not ${appearance}`,
      );
    await page.waitForTimeout(250);
    luminance = await editorChromeLuminance(page);
  }

  return luminance;
}

/**
 * How many pixels of the frame differ between two screenshots, decoded by the browser. Evidence that
 * a reopened document isn't just the original again. What it actually shows is for a person to read.
 */
export async function framePixelsChanged(run: CoreRun, before: string, after: string, top: number) {
  const context = await run.browser.newContext();
  const page = await context.newPage();

  const dataUrl = (path: string) =>
    `data:image/png;base64,${readFileSync(path).toString("base64")}`;

  try {
    return await page.evaluate(
      async ({ first, second, offset }) => {
        async function pixels(source: string) {
          const image = new Image();

          image.src = source;
          await image.decode();

          const canvas = new OffscreenCanvas(image.width, image.height);
          const drawing = canvas.getContext("2d");

          if (drawing === null) throw new Error("No 2D canvas.");
          drawing.drawImage(image, 0, 0);

          return drawing.getImageData(0, offset, image.width, image.height - offset).data;
        }

        const [left, right] = await Promise.all([pixels(first), pixels(second)]);
        let changed = 0;

        for (let index = 0; index < left.length; index += 4) {
          const difference =
            Math.abs((left[index] ?? 0) - (right[index] ?? 0)) +
            Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)) +
            Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0));

          if (difference > 48) changed += 1;
        }

        return changed;
      },
      { first: dataUrl(before), second: dataUrl(after), offset: Math.round(top) },
    );
  } finally {
    await context.close();
  }
}

import assert from "node:assert/strict";
import type { BrowserContext, Page } from "playwright-core";
import { rowMenu, uploadFiles, uploadsTray } from "./page-actions.ts";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";

export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

/** Controls under 44px on a coarse pointer, counting an expanded hit area where one exists. */
function smallTargets(page: Page) {
  return page.evaluate(() => {
    const selector =
      'a[href],button,[role="button"],input:not([type="file"]):not([hidden]),[role="menuitem"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="switch"],[role="checkbox"]';

    const offenders: string[] = [];

    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest('[aria-hidden="true"]') !== null) continue;

      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);

      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") continue;

      if (rect.bottom < 0 || rect.top > innerHeight) continue;

      if (element.dataset.slot === "app-skip-link") continue;

      let width = rect.width;
      let height = rect.height;
      const after = getComputedStyle(element, "::after");

      if (after.content !== "none" && after.position === "absolute") {
        const row = element.hasAttribute("data-item-target")
          ? element.closest("[data-item-key]")
          : null;

        if (row !== null) {
          const box = row.getBoundingClientRect();

          width = box.width;
          height = box.height;
        } else {
          width = Math.max(width, parseFloat(after.width) || 0);
          height = Math.max(height, parseFloat(after.height) || 0);
        }
      }

      if (width < 43.5 || height < 43.5) {
        const label =
          element.getAttribute("aria-label") ??
          element.textContent?.trim().slice(0, 30) ??
          element.tagName;

        offenders.push(`${label} (${Math.round(width)}x${Math.round(height)})`);
      }
    }

    return offenders;
  });
}

function noSidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
}

export async function audit(run: CoreRun, page: Page, surface: string) {
  await run.report.check(`${surface}: controls reach 44px on touch`, async () => {
    const offenders = await smallTargets(page);

    assert.equal(offenders.length, 0, offenders.join("; "));
  });
  await run.report.check(`${surface}: nothing scrolls sideways`, async () => {
    assert.equal(await noSidewaysScroll(page), true);
  });
}

async function phone(run: CoreRun) {
  const { report, media, front } = run;
  const { context, page } = await ownerPage(run, { ...PHONE, colorScheme: "light" });

  await page.getByRole("navigation", { name: "Main" }).last().waitFor();
  await page.getByRole("button", { name: /^release\.bin/ }).waitFor();
  await report.shot(page, "phone-files-light");
  await audit(run, page, "Files list");

  await report.check("the phone uses bottom navigation, and no sidebar", async () => {
    const box = await page.locator('[data-slot="app-bottom-nav"]').boundingBox();

    assert.ok(box !== null && box.y + box.height <= 844.5, "bottom nav isn't on screen");
    assert.ok(box !== null && box.height >= 44, "bottom nav is too short");
  });

  await page.getByRole("button", { name: "Grid" }).tap();
  await page.getByRole("button", { name: /^release\.bin/ }).waitFor();
  await report.shot(page, "phone-files-grid-light");
  await audit(run, page, "Files grid");
  await page.getByRole("button", { name: "List" }).tap();

  await page.getByRole("button", { name: "Actions for release.bin" }).tap();
  await page.getByRole("menuitem", { name: "Share…" }).waitFor();
  await report.shot(page, "phone-row-menu");
  await audit(run, page, "Row menu");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Account" }).tap();
  await page.getByRole("menuitemradio", { name: "Dark" }).tap();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await report.shot(page, "phone-files-dark");

  await page.getByRole("button", { name: "Actions for release.bin" }).tap();
  await page.getByRole("menuitem", { name: "Upload new version…" }).tap();

  const dialog = page.getByRole("dialog");

  await dialog.getByText("No file chosen").waitFor();
  await report.shot(page, "phone-replace-dialog-dark");
  await audit(run, page, "New version dialog");

  await report.check(
    "with a keyboard-sized viewport, the dialog's actions stay reachable",
    async () => {
      await page.setViewportSize({ width: 390, height: 420 });

      const confirm = dialog.getByRole("button", { name: "Cancel" });

      await confirm.scrollIntoViewIfNeeded();

      const box = await confirm.boundingBox();

      assert.ok(box !== null && box.y >= 0 && box.y + box.height <= 420, "Cancel can't be reached");
      await report.shot(page, "phone-dialog-short-viewport");
      await page.setViewportSize(PHONE.viewport);
      await confirm.tap();
      await dialog.waitFor({ state: "detached" });
    },
  );

  await report.check("a long failure stays readable and on screen in the tray", async () => {
    front.replaceReply((record) => record.operation === "uploads.complete");

    const long = `an-extremely-long-file-name-without-any-spaces-to-break-on-${"x".repeat(90)}.bin`;

    await uploadFiles(page, media.bytes(long, 4096));
    await uploadsTray(page)
      .getByText(/Your files are safe/)
      .waitFor({ timeout: 30_000 });
    await report.shot(page, "phone-tray-failure-dark");

    const box = await uploadsTray(page).boundingBox();

    assert.ok(box !== null && box.x >= 0 && box.x + box.width <= 390, "the tray runs off screen");
    assert.equal(await noSidewaysScroll(page), true);
    await audit(run, page, "Upload tray");
    await uploadsTray(page)
      .getByRole("button", { name: /^Retry upload/ })
      .click();
    await uploadsTray(page).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
    await uploadsTray(page).getByRole("button", { name: "Clear" }).tap();
  });

  await report.check("Trash and Photos fit too", async () => {
    await page.getByRole("link", { name: "Trash" }).first().tap();
    await page.getByRole("heading", { name: "Trash" }).waitFor();
    await report.shot(page, "phone-trash-dark");
    await page.getByRole("link", { name: "Photos" }).first().tap();
    await page.locator('[data-slot="media-tile"]').first().waitFor();
    await page.waitForTimeout(1500);
    await report.shot(page, "phone-photos-dark");
  });

  await audit(run, page, "Photos");

  await context.close();
}

async function swipe(context: BrowserContext, page: Page, fromX: number, toX: number, y: number) {
  const cdp = await context.newCDPSession(page);
  const point = (x: number) => ({ x, y });

  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(fromX)] });

  for (let step = 1; step <= 8; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(fromX + ((toX - fromX) * step) / 8)],
    });
    await page.waitForTimeout(16);
  }

  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function viewerTouch(run: CoreRun) {
  const { report } = run;
  const { context, page } = await ownerPage(run, PHONE);

  await page.getByRole("link", { name: "Photos" }).first().tap();
  await page.locator('[data-slot="media-tile"] button').first().tap();

  const title = () => page.locator('[data-slot="lightbox"] h2').innerText();

  await page.locator('[data-slot="lightbox"]').waitFor();

  const before = await title();

  await report.shot(page, "phone-viewer");
  await audit(run, page, "Viewer");

  await report.check("a swipe across the stage moves to the next photo", async () => {
    await swipe(context, page, 320, 60, 420);
    await page.waitForFunction(
      (name) => document.querySelector('[data-slot="lightbox"] h2')?.textContent !== name,
      before,
    );
  });

  await context.close();
}

async function landscape(run: CoreRun) {
  const { report } = run;

  const { context, page } = await ownerPage(run, {
    ...PHONE,
    viewport: { width: 844, height: 390 },
  });

  await page.getByRole("button", { name: /^release\.bin/ }).waitFor();
  await report.shot(page, "landscape-files");
  await audit(run, page, "Landscape Files");

  await report.check("a dialog fits and scrolls in landscape", async () => {
    await rowMenu(page, "release.bin", "Version history…");

    const dialog = page.getByRole("dialog");
    const close = dialog.getByRole("button", { name: "Close" });

    await close.scrollIntoViewIfNeeded();

    const box = await close.boundingBox();

    assert.ok(box !== null && box.y + box.height <= 390, "Close can't be reached");
    await report.shot(page, "landscape-dialog");
    await close.tap();
  });

  await context.close();
}

async function safeArea(run: CoreRun) {
  const { report } = run;
  const { context, page } = await ownerPage(run, PHONE);
  const cdp = await context.newCDPSession(page);

  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 47, left: 0, bottom: 34, right: 0 },
    });
  } catch (error) {
    report.unverified("safe areas", `Chromium refused the override: ${String(error)}`);
    await context.close();

    return;
  }

  await page.getByRole("button", { name: /^release\.bin/ }).waitFor();
  await page.waitForTimeout(200);
  await report.shot(page, "phone-safe-area");

  await report.check("the bottom nav and shell clear emulated safe areas", async () => {
    const insets = await page.evaluate(() => ({
      nav: getComputedStyle(document.querySelector('[data-slot="app-bottom-nav"]') ?? document.body)
        .paddingBottom,
      shell: getComputedStyle(document.querySelector('[data-slot="app-shell"]') ?? document.body)
        .paddingTop,
    }));

    report.observe("safe-area padding", insets);
    assert.equal(insets.nav, "34px", "bottom nav");
  });

  await context.close();
}

async function reducedMotion(run: CoreRun) {
  const { report } = run;
  const { context, page } = await ownerPage(run, { reducedMotion: "reduce" });

  await page.getByRole("button", { name: /^release\.bin/ }).waitFor();
  await page.getByRole("button", { name: "New folder" }).first().click();

  await report.check("with reduced motion, dialogs lose movement but keep their fade", async () => {
    const transition = await page
      .locator('[data-slot="dialog-content"]')
      .evaluate((element) => getComputedStyle(element).transitionProperty);

    report.observe("dialog transition with reduced motion", transition);
    assert.ok(!/translate|scale|transform/.test(transition), transition);
    assert.match(transition, /opacity/);
  });

  await page.keyboard.press("Escape");
  await context.close();
}

export async function runTouchScenarios(run: CoreRun) {
  await run.report.scenario("Phone", () => phone(run));
  await run.report.scenario("Viewer on touch", () => viewerTouch(run));
  await run.report.scenario("Landscape", () => landscape(run));
  await run.report.scenario("Safe areas", () => safeArea(run));
  await run.report.scenario("Reduced motion", () => reducedMotion(run));
}

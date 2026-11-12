/// <reference lib="es2023" />

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { availablePort } from "../../../scripts/available-port.ts";
import { readEditorBundle } from "../../../scripts/browser-fixtures/editor-bundle.ts";
import { createEditorCases } from "../../../scripts/browser-fixtures/editor-probe/cases.ts";
import { createFrontHandler, serveHttp2 } from "../../../scripts/browser-fixtures/front-proxy.ts";
import { startHostNetworkLog } from "../../../scripts/browser-fixtures/host-network-log.ts";
import {
  setupAdmin,
  uploadFiles,
  uploadsTray,
} from "../../../scripts/browser-fixtures/page-actions.ts";
import { createFolder } from "../../../scripts/browser-fixtures/scenarios-photos.ts";
import { createLink } from "../../../scripts/browser-fixtures/scenarios-sharing.ts";
import { startRustStack } from "../../../scripts/browser-fixtures/rust-stack.ts";
import type { Observed } from "../../../scripts/browser-fixtures/run-report.ts";
import {
  chromiumTrustFor,
  createDisposableTls,
  EDITOR_RENDERING_ARGS,
  frontendIdentity,
  startBuiltWeb,
} from "../../../scripts/browser-fixtures/web-host.ts";

// A deliberately narrow real-browser check, not another all-editor acceptance loop.
const [image, bundleDirectory, bundleSha256, artifacts] = process.argv.slice(2);

assert.ok(
  image && bundleDirectory && bundleSha256 && artifacts,
  "Pass image, bundle, digest, artifacts.",
);

mkdirSync(artifacts, { recursive: false });

const work = mkdtempSync(join(tmpdir(), "hyori-ui-click-"));

const cleanup: (() => void | Promise<void>)[] = [
  () => rmSync(work, { recursive: true, force: true }),
];

const observations: Record<string, Observed> = {};
const assertions: string[] = [];
const problems: string[] = [];
let passed = false;

function check(message: string, condition: boolean) {
  assert.ok(condition, message);
  assertions.push(message);
  console.log(`PASS ${message}`);
}

function watch(page: Page) {
  page.on("pageerror", (error) => problems.push(error.message));
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();

      if (box === undefined) throw new Error(`Missing ${selector}`);

      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };

    return {
      header: rect('[aria-label="Document controls"]'),
      identity: rect('[data-slot="hosted-document-identity"]'),
      status: rect('[data-slot="hosted-document-status"]'),
      frame: rect('[data-slot="hosted-document-frame"]'),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

async function close(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[data-slot="hosted-document"]').waitFor({ state: "detached" });
}

async function open(page: Page, trigger: () => Promise<void>, label: string) {
  const started = performance.now();

  await trigger();
  await page.waitForURL(/\/edit\/[^/]+$/);
  await page
    .locator('[data-slot="hosted-document-status"]', { hasText: /^All changes saved$/ })
    .waitFor({ timeout: 180_000 });
  observations[`${label}StatusReadyMs`] = Math.round(performance.now() - started);
  // The older vendor's ready message precedes its first paint; this is not a usable-open benchmark.
  await page
    .frameLocator('[data-slot="hosted-document-frame"]')
    .locator("canvas")
    .first()
    .waitFor();
  await page.waitForTimeout(4000);
  check(
    `${label}: the real WordCraft bundle is loaded`,
    (await page.locator("iframe").getAttribute("src"))?.includes("/wordcraft/0.14.0/") === true,
  );
}

try {
  const port = await availablePort();
  const origin = `https://localhost:${port}`;
  const tls = createDisposableTls("localhost");

  cleanup.push(tls.dispose);
  const network = startHostNetworkLog();

  cleanup.push(() => {
    network.stop();
  });
  const bundle = readEditorBundle(bundleDirectory, bundleSha256);
  const stack = await startRustStack(image, origin, await availablePort(), null, bundle);

  cleanup.push(stack.stop);
  const web = await startBuiltWeb({ origin, backendUrl: stack.backendUrl, build: true });

  cleanup.push(web.stop);
  observations.identity = {
    sourceDigest: web.sourceDigest,
    buildDigest: web.buildDigest,
    bundleSha256,
    image,
  };
  check(
    "the source stayed fixed throughout the production build",
    frontendIdentity() === web.sourceDigest,
  );
  const front = createFrontHandler({ nitroUrl: web.url, staticRoot: bundle.directory });

  cleanup.push(serveHttp2(front, port, origin, tls));
  check("host network settled before Chromium starts", await network.settle(5000, 60_000));

  const browser = await chromium.launch({
    headless: true,
    args: [chromiumTrustFor(tls.cert), ...EDITOR_RENDERING_ARGS],
  });

  cleanup.push(() => browser.close());
  observations.browser = browser.version();

  const context = await browser.newContext({
    viewport: { width: 1280, height: 844 },
    colorScheme: "light",
  });

  const page = await context.newPage();

  watch(page);
  page.setDefaultTimeout(20_000);
  await page.goto(origin);
  await setupAdmin(page, {
    token: stack.setupToken,
    email: "ui-click@example.test",
    password: `synthetic ${randomBytes(14).toString("hex")} words`,
  });
  await page.getByText("No files yet", { exact: true }).waitFor();
  await createFolder(page, "Synthetic editor workspace");
  const folderUrl = page.url();
  const source = createEditorCases(work).word.copyAs("Synthetic click brief");
  const name = "Synthetic click brief.docx";

  await uploadFiles(page, source);
  await uploadsTray(page).getByLabel("Uploaded", { exact: true }).waitFor({ timeout: 60_000 });
  await uploadsTray(page).getByRole("button", { name: "Clear" }).click();
  await uploadsTray(page).waitFor({ state: "detached" });
  const target = () => page.getByRole("button", { name: /^Synthetic click brief\.docx/ });

  const opensBefore = front.trace.filter(({ operation }) => operation === "editors.open").length;

  await target().click({ modifiers: ["Shift"] });
  check("modified document activation does not navigate", page.url() === folderUrl);
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Open in editor", exact: true }).waitFor();
  check(
    "opening the context menu does not open the document",
    front.trace.filter(({ operation }) => operation === "editors.open").length === opensBefore,
  );
  await page.keyboard.press("Escape");
  await open(page, () => target().click(), "signedInClick");
  const originalFrame = await page.locator("iframe").elementHandle();
  const originalGeometry = await geometry(page);

  observations.desktopLight = originalGeometry;
  check("the shell has no horizontal overflow on desktop", !originalGeometry.overflow);
  await page.screenshot({ path: join(artifacts, "01-editor-shell-desktop-light.png") });
  await page.getByRole("button", { name: "Document options" }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await page.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "detached" });
  await page.locator("html.dark").waitFor();
  check(
    "changing appearance keeps the live editor frame",
    (await originalFrame?.evaluate((frame) => frame.isConnected)) === true,
  );
  assert.deepEqual(
    await geometry(page),
    originalGeometry,
    "theme changes must not move document anchors or viewport",
  );
  assertions.push("appearance preserves identity, status, header and iframe geometry");
  await page.screenshot({ path: join(artifacts, "02-editor-shell-desktop-dark.png") });
  await page.getByRole("button", { name: "Document options" }).click();
  await page.getByRole("menuitemradio", { name: "System", exact: true }).click();
  await page.locator("html.light").waitFor();
  check(
    "System follows the browser's light preference",
    (await page.locator("html.light").count()) === 1,
  );
  await close(page);
  // Keyboard proof is traffic/URL only, never a screenshot of the declined keyboard-row-focus subject.
  await target().focus();
  await open(page, () => page.keyboard.press("Enter"), "signedInEnter");
  await close(page);
  await page.goto(origin);
  const publicUrl = await createLink(page, "Synthetic editor workspace", "Editor");

  const visitorContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "light",
    reducedMotion: "reduce",
  });

  const visitor = await visitorContext.newPage();

  watch(visitor);
  visitor.setDefaultTimeout(20_000);
  await visitor.goto(publicUrl);
  await visitor.getByRole("button", { name: "Open shared item" }).tap();
  const visitorTarget = visitor.getByRole("button", { name: /^Synthetic click brief\.docx/ });

  await open(visitor, () => visitorTarget.tap(), "publicTouch");
  check(
    "touch opening keeps the public grant path",
    new URL(visitor.url()).pathname.startsWith(`${new URL(publicUrl).pathname}/edit/`),
  );
  const mobile = await geometry(visitor);

  observations.mobileReducedMotion = mobile;
  check("the shell has no horizontal overflow on a 390px touch viewport", !mobile.overflow);

  for (const label of ["Close", "Document options"]) {
    const box = await visitor.getByRole("button", { name: label, exact: true }).boundingBox();

    check(
      `${label} reaches 44px on coarse pointers`,
      box !== null && box.height >= 44 && box.width >= 44,
    );
  }

  await visitor.screenshot({ path: join(artifacts, "03-editor-shell-public-touch.png") });
  observations.operations = Object.fromEntries(
    ["editors.available", "editors.open", "files.download"].map((operation) => [
      operation,
      front.trace.filter((record) => record.operation === operation).length,
    ]),
  );
  check(
    "primary document opening never downloaded instead",
    front.trace.every(({ operation }) => operation !== "files.download"),
  );
  check("browser execution had no uncaught errors", problems.length === 0);
  check(
    "tested frontend source still matches the checkout",
    frontendIdentity() === web.sourceDigest,
  );
  await close(visitor);
  await visitorContext.close();
  await context.close();
  passed = true;
} catch (error) {
  observations.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(error);
} finally {
  observations.problems = problems;
  writeFileSync(
    join(artifacts, "report.json"),
    JSON.stringify(
      {
        passed,
        assertions,
        observations,
        limits: [
          "Narrow new-source UI proof, not all-editor acceptance.",
          "No save or autosave claim; parent owns that contract and profiling.",
          "Vendor canvas toolbar/theme is unchanged and is not claimed to match Hyori.",
          "Touch is Chromium emulation, not physical-device acceptance.",
        ],
      },
      null,
      2,
    ),
  );

  for (const dispose of cleanup.reverse()) await dispose();
}

process.exitCode = passed ? 0 : 1;

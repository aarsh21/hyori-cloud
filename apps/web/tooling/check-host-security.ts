/** Verify the built host through its public origin, not mocked responses.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-host-security.ts /absolute/screenshots
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

declare global {
  interface Window {
    firstLoadPrivateFlash: boolean;
  }
}

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

const state = z
  .object({ email: z.string(), password: z.string(), folderId: z.string(), shareUrl: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        process.env.HYORI_DELIVERY_STATE ?? join(homedir(), "hyori-delivery/state.json"),
        "utf8",
      ),
    ),
  );

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome"),
  headless: true,
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.firstLoadPrivateFlash = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-slot="app-shell"]')) window.firstLoadPrivateFlash = true;
    }).observe(document, { subtree: true, childList: true });
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.goto(origin);
  const headers = await response!.allHeaders();
  assert.match(headers["content-security-policy"]!, /frame-ancestors 'none'/);
  assert.match(headers["content-security-policy"]!, /frame-src 'self'/);
  assert.doesNotMatch(
    headers["content-security-policy"]!,
    /script-src [^;]*'unsafe-(inline|eval)'/,
  );
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.ok(headers["permissions-policy"]?.includes("microphone=()"));
  assert.equal(headers["cache-control"], "private, no-store");
  assert.equal(headers["content-encoding"], "gzip");
  assert.equal(headers["strict-transport-security"], "max-age=31536000");
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();

  let currentHeaders = headers;

  for (const path of [`/folders/${state.folderId}`, "/admin", "/"]) {
    const signedOut = await page.goto(`${origin}${path}`);
    const body = await signedOut!.text();
    currentHeaders = await signedOut!.allHeaders();
    assert.equal(signedOut!.headers()["cache-control"], "private, no-store");
    assert.ok(!body.includes(state.email));
    assert.doesNotMatch(body, /document-\d+\.txt/);
    assert.ok(!body.includes('data-slot="app-shell"'));
    assert.doesNotMatch(
      body,
      /\/assets\/(?:signed-in-cloud|files-screen|photos-screen|admin-screen|editor-screen)-/,
    );
    assert.ok(body.includes("login-email"), "sign-in is present in the signed-out document");
    await page.getByRole("button", { name: "Appearance", expanded: false }).waitFor();
    assert.equal(await page.evaluate(() => window.firstLoadPrivateFlash), false);
    assert.equal(await page.locator('[data-slot="app-shell"]').count(), 0);
  }

  console.log(
    "PASS signed-out documents and hydrated private routes contain no private data/chrome",
  );
  // The following nonce checks refer to the current document, not the first navigation.
  const nonce = await page.locator('meta[property="csp-nonce"]').getAttribute("content");
  assert.ok(nonce && currentHeaders["content-security-policy"]!.includes(`'nonce-${nonce}'`));

  const inlineNonces = await page
    .locator("script:not([src])")
    .evaluateAll((scripts) =>
      scripts.map((script) => (script instanceof HTMLScriptElement ? script.nonce : null)),
    );

  assert.ok(inlineNonces.length > 0);
  assert.ok(inlineNonces.every((value) => value === nonce));

  const externalNonces = await page
    .locator('script[src], link[rel="modulepreload"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("nonce")));

  assert.ok(externalNonces.length > 0);
  assert.ok(externalNonces.every((value) => value === null));
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = 'document.documentElement.dataset.cspProbe = "executed"';
    document.head.append(script);
  });
  assert.equal(await page.locator("html").getAttribute("data-csp-probe"), null);
  console.log(
    "PASS HTML headers; every retained inline script nonced; injected unnonced script blocked",
  );
  const output = process.argv[2]!;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "login-after.png") });
  await page.getByRole("button", { name: "Sign in", exact: true, disabled: false }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByText("Delivery files", { exact: true })
    .waitFor()
    .catch(async (error) => {
      console.log("Sign-in transition:", await page.locator("body").innerText());
      throw error;
    });
  const second = await page.goto(`${origin}/folders/${state.folderId}`);
  assert.equal(second!.headers()["cache-control"], "private, no-store");
  const privateBody = await second!.text();
  assert.match(privateBody, /document-\d+\.txt/, "first listing is in the private document");
  assert.ok(privateBody.includes(state.email), "only the authenticated document carries identity");

  const privatePreloads = await page
    .locator('link[rel="modulepreload"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));

  assert.ok(privatePreloads.some((href) => href?.includes("/files-screen-")));
  assert.ok(privatePreloads.some((href) => href?.includes("/signed-in-cloud-")));
  assert.ok(!privatePreloads.some((href) => /\/(photos|admin|editor)-screen-/.test(href ?? "")));
  await page
    .getByRole("button", { name: /^document-\d+\.txt/ })
    .first()
    .waitFor();
  const nextNonce = await page.locator('meta[property="csp-nonce"]').getAttribute("content");
  assert.notEqual(nextNonce, nonce);
  assert.ok(
    (await second!.allHeaders())["content-security-policy"]!.includes(`'nonce-${nextNonce}'`),
  );
  await page.screenshot({ path: join(output, "files-after.png") });
  const action = page.getByRole("button", { name: /^Actions for document-/ }).first();
  await action.click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download", exact: true }).click(),
  ]);

  assert.equal(await download.failure(), null);
  assert.ok((await readFile((await download.path())!)).length > 0);
  console.log(
    "PASS sign-in, authenticated listing, per-response nonce rotation, real browser download",
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

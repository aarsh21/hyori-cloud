/** Verify the built host through its public origin, not mocked responses.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-host-security.ts /absolute/screenshots
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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
  assert.equal(headers["strict-transport-security"], "max-age=31536000");
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  const nonce = await page.locator('meta[property="csp-nonce"]').getAttribute("content");
  assert.ok(nonce && headers["content-security-policy"]!.includes(`'nonce-${nonce}'`));

  const inlineNonces = await page
    .locator("script:not([src])")
    .evaluateAll((scripts) =>
      scripts.map((script) => (script instanceof HTMLScriptElement ? script.nonce : null)),
    );

  assert.ok(inlineNonces.length > 0);
  assert.ok(inlineNonces.every((value) => value === nonce));
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
  await page.getByLabel("Email").fill(state.email);
  await page.getByLabel("Password", { exact: true }).fill(state.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Delivery files", { exact: true }).waitFor();
  const second = await page.goto(`${origin}/folders/${state.folderId}`);
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

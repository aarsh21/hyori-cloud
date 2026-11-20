/** Real Strict-cookie navigation through a built host; fixture credentials stay outside Git.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-cross-site-session.ts
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { observeDeliveryHydration, waitForDeliveryHydration } from "./delivery-hydration.ts";

declare global {
  interface Window {
    privateChromeFlashed: boolean;
  }
}

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

const state = z
  .object({ email: z.string(), password: z.string(), shareUrl: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        process.env.HYORI_DELIVERY_STATE ?? join(homedir(), "hyori-delivery/state.json"),
        "utf8",
      ),
    ),
  );

const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(
      `<a href="${origin}/">Private instance</a><a href="${new URL(state.shareUrl, origin).href}">Public link</a>`,
      { headers: { "content-type": "text/html" } },
    ),
});

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome"),
});

let failures = 0;

try {
  for (const publicLink of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });

    try {
      const login = await context.request.post(`${origin}/api/rpc`, {
        headers: { origin },
        data: { operation: "auth.login", input: { email: state.email, password: state.password } },
      });

      assert.equal(login.ok(), true, "fixture login must succeed");

      const strict = (await context.cookies(origin)).filter(
        (cookie) => cookie.httpOnly && cookie.sameSite === "Strict",
      );

      assert.ok(strict.length > 0, "test needs a real HttpOnly Strict session");
      const page = await context.newPage();
      await page.addInitScript(observeDeliveryHydration, "button,a[href]");
      await page.goto(origin);
      await page.getByText("Delivery files", { exact: true }).waitFor();
      await page.goto(outside.url.href);

      const documentRequest = page.waitForRequest(
        (request) => request.isNavigationRequest() && new URL(request.url()).origin === origin,
      );

      await page
        .getByRole("link", { name: publicLink ? "Public link" : "Private instance", exact: true })
        .click();
      const headers = await (await documentRequest).allHeaders();
      const sessionSent = strict.some((cookie) => headers.cookie?.includes(`${cookie.name}=`));
      assert.equal(sessionSent, false, "cross-site document must omit the Strict session");
      assert.equal(headers["sec-fetch-site"], "cross-site");

      if (publicLink) {
        const consent = page.getByRole("button", { name: "Open", exact: true });
        await waitForDeliveryHydration(consent);
        assert.equal(await page.locator('[data-slot="app-shell"]').count(), 0);
        await consent.click();
        await page
          .getByRole("button", { name: /^document-\d+\.txt/ })
          .first()
          .waitFor();
        assert.equal(
          await page.locator('[data-slot="sidebar"], [data-slot="app-bottom-nav"]').count(),
          0,
        );
        assert.equal(await page.getByRole("button", { name: "Account", exact: true }).count(), 0);
        assert.equal(await page.getByText(state.email, { exact: true }).count(), 0);
        console.log(
          "PASS signed-in cross-site share: document cookie absent; consent then shared listing, no private chrome",
        );
      } else {
        const arrived = await page
          .getByText("Delivery files", { exact: true })
          .waitFor({ timeout: 5_000 })
          .then(
            () => true,
            () => false,
          );

        console.log(
          JSON.stringify({
            screen: "private",
            documentSessionSent: sessionSent,
            filesWithoutReload: arrived,
            signInVisible: await page
              .getByRole("button", { name: "Sign in", exact: true })
              .isVisible(),
          }),
        );

        if (!arrived) failures++;
      }
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.assign(window, { privateChromeFlashed: false });
      new MutationObserver(() => {
        if (document.querySelector('[data-slot="app-shell"]'))
          Object.assign(window, { privateChromeFlashed: true });
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(outside.url.href);
    await page.getByRole("link", { name: "Private instance", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true, disabled: false }).waitFor();
    assert.equal(await page.evaluate(() => window.privateChromeFlashed), false);
    console.log("PASS signed-out cross-site private visit: sign-in without private chrome flash");
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
  outside.stop(true);
}

assert.equal(
  failures,
  0,
  "a Strict-cookie cross-site arrival must recover the signed-in account without reload",
);

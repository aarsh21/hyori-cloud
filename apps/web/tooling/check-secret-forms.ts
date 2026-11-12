/** Exercise a built host: hold external JavaScript for six seconds and attempt native submission.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-secret-forms.ts [capture-directory]
 * Uses deliberately invalid tokens and synthetic credentials; never creates or resets an account.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;
const captures = process.argv[2];

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome"),
});

let failures = 0;

try {
  if (captures) await mkdir(captures, { recursive: true });

  for (const mobile of [false, true]) {
    for (const screen of ["invite", "reset-password"] as const) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        isMobile: mobile,
        hasTouch: mobile,
      });

      try {
        const page = await context.newPage();
        const secret = "synthetic form guard password";
        const field = screen === "invite" ? "password" : "newPassword";
        const navigations: { method: string; secretInUrl: boolean }[] = [];
        let releaseScripts = () => {};
        const held = new Promise<void>((resolve) => (releaseScripts = resolve));
        const holdTimer = setTimeout(releaseScripts, 6_000);

        await page.route("**/assets/*.js", async (route) => {
          await held;
          await route.continue();
        });
        page.on("request", (request) => {
          if (request.isNavigationRequest())
            navigations.push({
              method: request.method(),
              secretInUrl: new URL(request.url()).searchParams.get(field) === secret,
            });
        });

        try {
          await page.goto(`${origin}/${screen}/${"0".repeat(64)}`, {
            waitUntil: "commit",
          });
          const password = page.locator(`input[name="${field}"]`);
          await password.waitFor();

          if (screen === "invite") {
            await page.getByLabel("Name", { exact: true }).fill("Form guard");
            await page.getByLabel("Email", { exact: true }).fill("form-guard@example.test");
          }

          await password.fill(secret);
          const submit = page.locator('button[type="submit"]');
          const disabled = await submit.isDisabled();
          const method = await page.evaluate(() => document.querySelector("form")?.method);

          if (captures)
            await page.screenshot({
              path: join(captures, `${mobile ? "phone" : "desktop"}-${screen}-scripts-held.jpg`),
              type: "jpeg",
              quality: 80,
            });

          // Real implicit submission exercises Enter; an enabled button also gets a real click.
          await password.press("Enter");

          if (!disabled && !navigations.some((navigation) => navigation.secretInUrl))
            await submit.click({ noWaitAfter: true });

          await held;
          await page.waitForLoadState("networkidle");
          const leaked = navigations.some((navigation) => navigation.secretInUrl);
          const safe = !leaked && disabled && method === "post";
          console.log(
            JSON.stringify({
              mobile,
              screen,
              method,
              disabled,
              passwordInNavigation: leaked,
              safe,
            }),
          );

          if (!safe) failures++;
          else {
            await submit.waitFor({ state: "visible" });
            assert.equal(await submit.isEnabled(), true, "hydration must enable submission");
            assert.equal(
              await password.inputValue(),
              secret,
              "hydration must preserve typed input",
            );

            const rpc = page.waitForRequest(
              (request) =>
                request.url().endsWith("/api/rpc") && request.postData()?.includes(secret) === true,
            );

            await submit.click();
            assert.equal((await rpc).method(), "POST");
            assert.equal(new URL(page.url()).search, "");
          }
        } finally {
          clearTimeout(holdTimer);
          releaseScripts();
        }
      } finally {
        await context.close();
      }
    }
  }

  const context = await browser.newContext({ javaScriptEnabled: false });

  try {
    const page = await context.newPage();
    const response = await page.goto(`${origin}/share/deliberately-invalid-guard-token`);
    assert.ok(response);
    assert.match(await response.text(), /Open shared item/);
    assert.equal(await page.locator('input[type="password"],form').count(), 0);
    console.log("PASS public-share document contains consent only, no password form");
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

assert.equal(
  failures,
  0,
  `${failures} server-rendered secret forms permit unsafe native submission`,
);

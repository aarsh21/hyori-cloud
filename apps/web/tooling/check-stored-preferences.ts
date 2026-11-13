/** Real reloads with application modules held for five seconds.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-stored-preferences.ts [report.json] [screenshots-directory]
 * Uses the private delivery fixture; never writes credentials or session cookies to the report.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

type PreferenceObservations = {
  wrongLayoutFrames: number;
  wrongSidebarFrames: number;
  wrongShortcutFrames: number;
  firstEntryMs: number | null;
  cls: number;
  shifts: number[];
};

declare global {
  interface Window {
    preferenceObservations: PreferenceObservations;
  }
}

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

const state = z
  .object({ email: z.string(), password: z.string(), folderId: z.string() })
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
});

const results: unknown[] = [];
let failures = 0;
const shots = process.argv[3];

if (shots) await mkdir(shots, { recursive: true });

try {
  const auth = await browser.newContext();

  const login = await auth.request.post(`${origin}/api/rpc`, {
    headers: { origin },
    data: { operation: "auth.login", input: { email: state.email, password: state.password } },
  });

  assert(login.ok(), `fixture login failed: ${login.status()}`);
  const cookies = await auth.cookies();
  await auth.close();

  for (const mobile of [false, true]) {
    for (const choice of ["defaults", "grid", "collapsed", "grid-collapsed", "shortcuts-off"]) {
      const grid = choice.includes("grid");
      const collapsed = choice.includes("collapsed");
      const shortcutsOff = choice === "shortcuts-off";

      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: process.env.HYORI_DELIVERY_APPEARANCE === "dark" ? "dark" : "light",
      });

      const label = `${mobile ? "phone" : "desktop"}-${choice}`;
      let release = () => {};

      try {
        await context.addCookies(cookies);
        const page = await context.newPage();
        const problems: string[] = [];
        page.on("pageerror", (error) => problems.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(message.text());
        });
        await page.addInitScript(
          ({ grid, collapsed, shortcutsOff }) => {
            localStorage.setItem("hyori-item-layout", grid ? "grid" : "list");
            localStorage.setItem("hyori-sidebar", collapsed ? "collapsed" : "open");
            localStorage.setItem("hyori-single-key-shortcuts", shortcutsOff ? "off" : "on");

            const observations: PreferenceObservations = {
              wrongLayoutFrames: 0,
              wrongSidebarFrames: 0,
              wrongShortcutFrames: 0,
              firstEntryMs: null,
              cls: 0,
              shifts: [],
            };

            Object.assign(window, { preferenceObservations: observations });
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                // SAFETY: this observer subscribes only to the browser's layout-shift entries.
                const shift = entry as PerformanceEntry & { value: number };
                observations.cls += shift.value;
                observations.shifts.push(shift.value);
              }
            }).observe({ type: "layout-shift", buffered: true });

            const visible = (element: Element | null) =>
              element?.checkVisibility({ visibilityProperty: true }) === true &&
              element.getBoundingClientRect().width > 0;

            const observe = () => {
              const first = [...document.querySelectorAll("button")].find((e) =>
                /^document-\d+\.txt/.test(e.textContent ?? ""),
              );

              if (visible(first ?? null)) {
                observations.firstEntryMs ??= performance.now();

                const pressed = document
                  .querySelector('button[aria-label="Grid"]')
                  ?.getAttribute("aria-pressed");

                if ((pressed === "true") !== grid) observations.wrongLayoutFrames++;
              }

              if (collapsed && visible(document.querySelector('[data-slot="sidebar"]')))
                observations.wrongSidebarFrames++;

              if (shortcutsOff && visible(document.querySelector('[data-slot="search-field"] kbd')))
                observations.wrongShortcutFrames++;
              requestAnimationFrame(observe);
            };

            requestAnimationFrame(observe);
          },
          { grid, collapsed, shortcutsOff },
        );

        await page.goto(`${origin}/folders/${state.folderId}`);
        await page.waitForLoadState("networkidle");

        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        await page.route("**/assets/*.js", async (route) => {
          await held;
          await route.continue();
        });

        const response = await page.reload({ waitUntil: "commit" });

        assert(response);
        const csp = response.headers()["content-security-policy"] ?? "";
        assert(!/script-src[^;]*'unsafe-inline'/.test(csp), "script CSP weakened");
        await page.locator('[data-slot="sidebar-wrapper"]').waitFor({ state: "attached" });
        await page.waitForTimeout(5_000);
        const entry = page.getByRole("button", { name: /^document-\d+\.txt/ }).first();
        const beforeVisible = await entry.isVisible();
        const heldEntryBox = await entry.boundingBox();
        const heldGrid = await page.locator('[data-slot="item-grid"]').isVisible();
        const heldSidebar = await page.locator('[data-slot="sidebar"]').isVisible();

        if (shots)
          await page.screenshot({
            path: join(shots, `${label}-held.jpg`),
            type: "jpeg",
            quality: 80,
          });

        const missingNonce = await page
          .locator("script:not([src])")
          .evaluateAll((scripts) =>
            scripts.some((script) => script instanceof HTMLScriptElement && !script.nonce),
          );

        assert.equal(missingNonce, false, "inline script has no nonce");
        release();
        await entry.waitFor();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(250);

        if (shots)
          await page.screenshot({
            path: join(shots, `${label}-ready.jpg`),
            type: "jpeg",
            quality: 80,
          });

        const observations = await page.evaluate(() => window.preferenceObservations);

        const pressed = await page
          .getByRole("button", { name: "Grid", exact: true })
          .getAttribute("aria-pressed");

        const sidebarVisible = await page.locator('[data-slot="sidebar"]').isVisible();
        const faults: string[] = [];

        if (!beforeVisible)
          faults.push("stored layout content is absent while application modules are held");

        if (heldGrid !== grid) faults.push(`held Grid visible=${heldGrid}`);

        if (heldSidebar !== (!mobile && !collapsed))
          faults.push(`held sidebar visible=${heldSidebar}`);

        if (JSON.stringify(heldEntryBox) !== JSON.stringify(await entry.boundingBox()))
          faults.push("first entry geometry changed when application modules started");

        if (observations.wrongLayoutFrames)
          faults.push(`wrong layout on ${observations.wrongLayoutFrames} frames`);

        if (observations.wrongSidebarFrames)
          faults.push(`wrong sidebar on ${observations.wrongSidebarFrames} frames`);

        if (observations.wrongShortcutFrames)
          faults.push(`disabled shortcut on ${observations.wrongShortcutFrames} frames`);

        if (pressed !== String(grid)) faults.push(`final Grid pressed=${pressed}`);

        if (sidebarVisible !== (!mobile && !collapsed))
          faults.push(`final sidebar visible=${sidebarVisible}`);

        if (observations.cls > 0.01) faults.push(`CLS ${observations.cls} exceeds 0.01`);

        if (problems.length) faults.push(...problems);

        if (
          shortcutsOff &&
          (await page.getByRole("searchbox").locator("..").locator("kbd").count())
        )
          faults.push("disabled shortcut hint is visible");

        const result = {
          label,
          beforeVisible,
          heldGrid,
          heldSidebar,
          heldEntryBox,
          ...observations,
          pressed,
          sidebarVisible,
          faults,
        };

        results.push(result);
        console.log(`${faults.length ? "FAIL" : "PASS"} ${JSON.stringify(result)}`);

        if (faults.length) failures++;
      } catch (error) {
        failures++;
        results.push({ label, error: String(error) });
        console.error(`FAIL ${label}: ${String(error)}`);
      } finally {
        release();
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(results, null, 2));

process.exitCode = failures ? 1 : 0;

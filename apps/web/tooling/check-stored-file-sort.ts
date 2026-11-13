/** First-paint sorting proof against the private real-stack delivery fixture.
 * HYORI_DELIVERY_ORIGIN=https://… HYORI_DELIVERY_STATE=/private/state.json
 * bun apps/web/tooling/check-stored-file-sort.ts report.json screenshots-directory
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const entry = z.object({
  id: z.string(),
  name: z.string(),
  file: z.boolean(),
  size: z.number(),
  modified: z.number(),
});

const state = z
  .object({
    email: z.string(),
    password: z.string(),
    sortCases: z.array(z.object({ label: z.string(), path: z.string(), items: z.array(entry) })),
    publicPath: z.string(),
    publicItems: z.array(entry),
  })
  .parse(JSON.parse(await readFile(process.env.HYORI_DELIVERY_STATE!, "utf8")));

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;
const shots = process.argv[3];

if (shots) await mkdir(shots, { recursive: true });

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome"),
});

const results: unknown[] = [];
let failures = 0;

type Sort = "nameAsc" | "sizeDesc" | "modifiedAsc";

function ordered(items: z.infer<typeof entry>[], sort: Sort) {
  return [...items]
    .sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      let comparison = x < y ? -1 : Number(x > y);

      if (sort === "modifiedAsc") comparison = a.modified - b.modified;
      else if (sort === "sizeDesc" && a.file && b.file) comparison = a.size - b.size;
      comparison ||= a.id < b.id ? -1 : 1;

      return Number(a.file) - Number(b.file) || comparison * (sort === "sizeDesc" ? -1 : 1);
    })
    .map((item) => item.id);
}

declare global {
  interface Window {
    sortPaint: { wrongFrames: number; firstEntryMs: number | null; samples: number };
  }
}

try {
  const auth = await browser.newContext();

  const login = await auth.request.post(`${origin}/api/rpc`, {
    headers: { origin },
    data: { operation: "auth.login", input: { email: state.email, password: state.password } },
  });

  assert(login.ok(), `fixture login ${login.status()}`);
  const cookies = await auth.cookies();
  await auth.close();

  const scenarios: {
    scope: (typeof state.sortCases)[number];
    theme: string;
    mobile: boolean;
    grid: boolean;
    sort: Sort;
    mirror: string;
  }[] = state.sortCases.flatMap((scope) =>
    ["light", "dark"].flatMap((theme) =>
      [false, true].flatMap((mobile) =>
        [false, true].flatMap((grid) =>
          (["sizeDesc", "modifiedAsc"] as const).map((sort) => ({
            scope,
            theme,
            mobile,
            grid,
            sort,
            mirror: "matching",
          })),
        ),
      ),
    ),
  );

  for (const mirror of ["missing", "stale", "malformed", "legacy"])
    scenarios.push({
      scope: state.sortCases[0]!,
      theme: "light",
      mobile: false,
      grid: true,
      sort: mirror === "legacy" ? "nameAsc" : "sizeDesc",
      mirror,
    });

  for (const scenario of scenarios) {
    const { scope, theme, mobile, grid, sort, mirror } = scenario;
    const label = `${scope.label}-${theme}-${mobile ? "phone" : "desktop"}-${grid ? "grid" : "list"}-${sort}-${mirror}`;

    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      isMobile: mobile,
      hasTouch: mobile,
      colorScheme: theme === "dark" ? "dark" : "light",
    });

    let release = () => {};

    try {
      await context.addCookies(cookies);
      let value = `2.${grid ? "g" : "l"}.o.1.${mirror === "stale" ? 0 : sort === "sizeDesc" ? 3 : 4}`;

      if (mirror === "legacy") value = "1.g.o.1";
      else if (mirror === "malformed") value = "2.g.o.1.99";

      if (mirror !== "missing")
        await context.addCookies([
          {
            name: "hyori_ui",
            value,
            url: origin,
          },
        ]);
      const page = await context.newPage();
      const expected = ordered(scope.items, sort).slice(0, 100);
      await page.addInitScript(
        ({ grid, sort, expected }) => {
          localStorage.setItem("hyori-item-layout", grid ? "grid" : "list");
          localStorage.setItem("hyori-file-sort", sort);
          Object.assign(window, { sortPaint: { wrongFrames: 0, firstEntryMs: null, samples: 0 } });

          const frame = () => {
            const rows = [...document.querySelectorAll<HTMLElement>("[data-item-key]")];

            if (rows[0]?.checkVisibility({ visibilityProperty: true })) {
              window.sortPaint.firstEntryMs ??= performance.now();
              window.sortPaint.samples++;

              if (rows.some((row, index) => row.dataset.itemKey !== expected[index]))
                window.sortPaint.wrongFrames++;
            }

            requestAnimationFrame(frame);
          };

          requestAnimationFrame(frame);
        },
        { grid, sort, expected },
      );

      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      let heldModules = 0;
      await page.route("**/assets/*.js", async (route) => {
        heldModules++;
        await held;
        await route.continue();
      });
      const response = await page.goto(`${origin}${scope.path}`, { waitUntil: "commit" });
      assert.equal(response?.headers()["cache-control"], "private, no-store");
      await page.locator('[data-slot="sidebar-wrapper"]').waitFor({ state: "attached" });
      await page.waitForTimeout(5_000);
      assert(heldModules > 0, "application modules were not held");
      const visible = await page.locator("[data-item-key]").first().isVisible();
      const fallback = ["missing", "stale", "malformed"].includes(mirror);
      assert.equal(visible, !fallback, "held first-paint content");

      if (!fallback) {
        assert.deepEqual(
          await page
            .locator("[data-item-key]")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-item-key"))),
          expected,
        );
        assert.equal(await page.locator('[data-slot="item-grid"]').isVisible(), grid);
      }

      if (shots)
        await page.screenshot({
          path: join(shots, `${label}-held.jpg`),
          type: "jpeg",
          quality: 80,
        });
      const heldPaint = await page.evaluate(() => window.sortPaint);
      release();
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(
        (first) =>
          document.querySelector("[data-item-key]")?.getAttribute("data-item-key") === first &&
          document.querySelector("[data-item-key]")?.checkVisibility({ visibilityProperty: true }),
        expected[0],
      );
      const paint = await page.evaluate(() => window.sortPaint);
      assert.equal(paint.wrongFrames, 0);
      assert(paint.samples > 0);

      if (mobile) assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
      results.push({
        label,
        heldModules,
        visibleDuringHold: visible,
        heldPaint,
        ...paint,
        expectedFirst: expected[0],
      });
      console.log(`PASS ${label}`);
    } catch (error) {
      failures++;
      results.push({ label, error: String(error) });
      console.error(`FAIL ${label}: ${String(error)}`);
    } finally {
      release();
      await context.close();
    }
  }

  // Public consent deliberately starts unresolved: no first-document listing, no account data.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  try {
    const page = await context.newPage();
    const requests: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/rpc")) {
        const body = request.postDataJSON();

        if (body.operation === "files.list") requests.push(body);
      }
    });
    const expected = ordered(state.publicItems, "sizeDesc");
    await page.addInitScript(
      ({ expected }) => {
        localStorage.setItem("hyori-file-sort", "sizeDesc");
        Object.assign(window, { sortPaint: { wrongFrames: 0, firstEntryMs: null, samples: 0 } });

        const frame = () => {
          const rows = [...document.querySelectorAll<HTMLElement>("[data-item-key]")];

          if (rows[0]?.checkVisibility({ visibilityProperty: true })) {
            window.sortPaint.samples++;

            if (rows.some((row, index) => row.dataset.itemKey !== expected[index]))
              window.sortPaint.wrongFrames++;
          }

          requestAnimationFrame(frame);
        };

        requestAnimationFrame(frame);
      },
      { expected },
    );
    await page.goto(`${origin}${state.publicPath}`);
    await page.getByRole("button", { name: "Open shared item", exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await page.getByRole("button", { name: "Open shared item", exact: true }).tap();
    await page.locator("[data-item-key]").first().waitFor();
    await page.waitForTimeout(250);
    assert(requests.length > 0);

    for (const request of requests)
      assert.equal(
        z.object({ input: z.object({ sort: z.string() }) }).parse(request).input.sort,
        "sizeDesc",
      );
    const paint = await page.evaluate(() => window.sortPaint);
    assert.equal(paint.wrongFrames, 0);
    assert(paint.samples > 0);

    if (shots)
      await page.screenshot({
        path: join(shots, "public-phone-sizeDesc.jpg"),
        type: "jpeg",
        quality: 80,
      });
    results.push({ label: "public-after-explicit-open", requests, ...paint });
    console.log("PASS public-after-explicit-open");
  } catch (error) {
    failures++;
    results.push({ label: "public-after-explicit-open", error: String(error) });
    console.error(String(error));
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(
  process.argv[2]!,
  JSON.stringify({ passed: results.length - failures, failed: failures, results }, null, 2),
);

process.exitCode = failures ? 1 : 0;

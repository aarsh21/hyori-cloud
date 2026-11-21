/** Same delivery fixture/profile, fresh-context Files → Photos → Shared → Files trips; phones tap. */
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { observeDeliveryHydration, waitForDeliveryHydration } from "./delivery-hydration.ts";

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

/** The speed budgets ask for the p75 of 5 fresh-context runs per profile. */
const RUNS = z.coerce
  .number()
  .int()
  .min(1)
  .max(20)
  .parse(process.env.HYORI_DELIVERY_RUNS ?? 5);

const state = z
  .object({ email: z.string(), password: z.string() })
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

const results: {
  mobile: boolean;
  run: number;
  section: string;
  usableMs: number;
  /** Photos only: until the first tile's thumbnail is loaded and decoded. */
  thumbnailMs?: number;
}[] = [];

try {
  for (const mobile of [false, true]) {
    if (process.argv[3] && process.argv[3] !== (mobile ? "mobile" : "desktop")) continue;

    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        hasTouch: mobile,
        isMobile: mobile,
      });

      try {
        const login = await context.request.post(`${origin}/api/rpc`, {
          headers: { origin },
          data: { operation: "auth.login", input: state },
        });

        if (!login.ok()) throw new Error(`Login failed: ${login.status()}`);
        const page = await context.newPage();
        await page.addInitScript(observeDeliveryHydration, "button,a[href]");
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");

        if (mobile) {
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: 150,
            downloadThroughput: 200_000,
            uploadThroughput: 93_750,
          });
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        }

        await page.goto(origin);
        await page.getByText("Delivery files", { exact: true }).waitFor();
        await waitForDeliveryHydration(page.locator("a:visible").filter({ hasText: /^Photos$/ }));
        await page.waitForLoadState("networkidle");

        for (const section of ["Photos", "Shared", "Files"]) {
          const link = page.locator("a:visible").filter({ hasText: new RegExp(`^${section}$`) });
          await waitForDeliveryHydration(link);
          let documentNavigation = false;
          const navigated = () => (documentNavigation = true);
          page.on("domcontentloaded", navigated);
          let start: number;

          if (mobile) {
            // A real tap holds about 100 ms between touching down and lifting off, and the section's
            // prefetch starts on the down. The visit is timed from the lift, when it navigates.
            const box = (await link.boundingBox())!;
            const touchPoints = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints });
            await page.waitForTimeout(100);
            start = performance.now();
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            start = performance.now();
            await link.click();
          }

          let thumbnailMs: number | undefined;

          if (section === "Photos") {
            await page
              .getByRole("button", { name: /^photo-\d+\.png/ })
              .first()
              .waitFor();

            // Past the tile to the photo someone actually sees: the first thumbnail loaded and
            // decoded. Derivatives may still be generating when the tile itself is already there.
            await page
              .waitForFunction(() => {
                const image = document.querySelector<HTMLImageElement>(
                  'img[data-slot="media-tile-image"]',
                );

                return image !== null && image.complete && image.naturalWidth > 0;
              })
              .then(() =>
                page.evaluate(() =>
                  document
                    .querySelector<HTMLImageElement>('img[data-slot="media-tile-image"]')!
                    .decode(),
                ),
              );
            thumbnailMs = performance.now() - start;
          } else if (section === "Shared")
            await page.getByText("Nothing shared with you yet", { exact: true }).waitFor();
          else await page.getByText("Delivery files", { exact: true }).waitFor();

          const usableMs = performance.now() - start;
          page.off("domcontentloaded", navigated);

          if (documentNavigation) throw new Error(`${section} reloaded the document`);

          const entry: (typeof results)[number] = { mobile, run, section, usableMs };

          if (thumbnailMs !== undefined) entry.thumbnailMs = thumbnailMs;
          results.push(entry);
          console.log(JSON.stringify(entry));
          await page.waitForLoadState("networkidle");
        }
      } finally {
        await context.close();
      }
    }
  }

  await writeFile(process.argv[2]!, JSON.stringify(results, null, 2));

  // One line per profile and section, so a budget can be read straight off the run.
  for (const mobile of [false, true]) {
    for (const section of ["Photos", "Shared", "Files"]) {
      const runs = results.filter(
        (result) => result.mobile === mobile && result.section === section,
      );

      const times = runs.flatMap((result) => [result.usableMs]).sort((a, b) => a - b);

      if (times.length)
        console.log(
          `${mobile ? "phone" : "desktop"} ${section}: p50 ${times[Math.floor(times.length / 2)]!.toFixed(0)} ms, p75 ${times[Math.ceil(0.75 * (times.length - 1))]!.toFixed(0)} ms, max ${times.at(-1)!.toFixed(0)} ms over ${times.length} runs`,
        );

      const thumbnails = runs
        .flatMap((result) => (result.thumbnailMs !== undefined ? [result.thumbnailMs] : []))
        .sort((a, b) => a - b);

      if (thumbnails.length)
        console.log(
          `${mobile ? "phone" : "desktop"} ${section} thumbnail: p50 ${thumbnails[Math.floor(thumbnails.length / 2)]!.toFixed(0)} ms, p75 ${thumbnails[Math.ceil(0.75 * (thumbnails.length - 1))]!.toFixed(0)} ms, max ${thumbnails.at(-1)!.toFixed(0)} ms over ${thumbnails.length} runs`,
        );
    }
  }
} finally {
  await browser.close();
}

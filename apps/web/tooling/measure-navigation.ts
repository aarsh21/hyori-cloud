/** Same delivery fixture/profile, three fresh-context Files → Photos → Shared → Files trips. */
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { observeDeliveryHydration, waitForDeliveryHydration } from "./delivery-hydration.ts";

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

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

const results: { mobile: boolean; run: number; section: string; usableMs: number }[] = [];

try {
  for (const mobile of [false, true]) {
    if (process.argv[3] && process.argv[3] !== (mobile ? "mobile" : "desktop")) continue;

    for (let run = 0; run < 3; run++) {
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
          const start = performance.now();
          await link.click();

          if (section === "Photos")
            await page
              .getByRole("button", { name: /^photo-\d+\.png/ })
              .first()
              .waitFor();
          else if (section === "Shared")
            await page.getByText("Nothing shared with you yet", { exact: true }).waitFor();
          else await page.getByText("Delivery files", { exact: true }).waitFor();

          const usableMs = performance.now() - start;
          page.off("domcontentloaded", navigated);

          if (documentNavigation) throw new Error(`${section} reloaded the document`);
          results.push({ mobile, run, section, usableMs });
          console.log(JSON.stringify(results.at(-1)));
          await page.waitForLoadState("networkidle");
        }
      } finally {
        await context.close();
      }
    }
  }

  await writeFile(process.argv[2]!, JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

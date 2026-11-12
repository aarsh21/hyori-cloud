import assert from "node:assert/strict";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { PHONE } from "./scenarios-touch.ts";

/** These are rendered review surfaces, not substitutes for the action assertions in other scenarios. */
export async function runScreenScenarios(run: CoreRun) {
  for (const phone of [false, true]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const size = phone ? "phone" : "desktop";

      await run.report.scenario(`Screen review: ${size} ${colorScheme}`, async () => {
        const { context, page } = await ownerPage(run, {
          ...(phone ? PHONE : { deviceScaleFactor: 2 }),
          colorScheme,
        });

        try {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), phone);

          for (const [screen, path, heading] of [
            ["files", "/", "Files"],
            ["shared", "/shared", "Shared with me"],
            ["trash", "/trash", "Trash"],
            ["photos", "/photos", "Photos"],
            ["albums", "/photos/albums", "Photos"],
            ["users", "/admin", "Users"],
          ]) {
            await run.report.check(
              `${size} ${colorScheme}: ${screen} renders without horizontal overflow`,
              async () => {
                await page.goto(`${run.origin}${path}`);
                await page
                  .getByRole("heading", { name: heading, exact: true })
                  .waitFor({ state: "attached" });
                await page.waitForLoadState("networkidle");
                await run.report.shot(page, `screen-${screen}-${size}-${colorScheme}`);
                assert.equal(
                  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                  true,
                );
                assert.equal(
                  await page.evaluate(() => document.documentElement.classList.contains("dark")),
                  colorScheme === "dark",
                );
              },
            );
          }
        } finally {
          await context.close();
        }
      });
    }
  }
}

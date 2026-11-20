import assert from "node:assert/strict";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import {
  closeViewer,
  openPhotos,
  tile,
  tileSelector,
  waitForTrayIdle,
} from "./scenarios-photos.ts";
import { uploadFiles } from "./page-actions.ts";
import { PHONE } from "./scenarios-touch.ts";

export async function runReadinessPhotoScenarios(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";

  if (run.worker === null) {
    run.report.unverified(
      `${size}: album media and real derivatives`,
      "Needs --worker; no original-image substitution is used.",
    );

    return;
  }

  await run.report.scenario(
    `${size} readiness: automatic library and album membership`,
    async () => {
      const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
      const folder = `Photo review ${size}`;
      const image = `review-${size}.png`;
      const video = `review-${size}.mp4`;

      try {
        await page.getByRole("button", { name: "New folder", exact: true }).first().click();
        await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill(folder);
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await page.getByRole("link", { name: new RegExp(`^${folder}`) }).click();
        await uploadFiles(page, [
          run.media.png(image, phone ? 72 : 41),
          run.media.fixture("mp4", video),
        ]);
        await waitForTrayIdle(run, page, 2);
        await openPhotos(page, image);

        await run.report.check(
          `${size}: uploaded media reaches the library with no setup, derivatives decoded`,
          async () => {
            for (const name of [image, video]) {
              await page.waitForFunction(
                (selector) => {
                  const img = document.querySelector(selector)?.querySelector("img");

                  return (
                    img !== undefined &&
                    img !== null &&
                    img.complete &&
                    img.naturalWidth > 0 &&
                    (img.getAttribute("src") ?? "").includes("/derivatives/")
                  );
                },
                tileSelector(name),
                { timeout: 240_000 },
              );
            }

            await run.report.shot(page, `readiness-${size}-photos-ready`);
            assert.equal(await page.locator('[data-slot="media-tile-badge"]').count(), 1);
          },
        );
        await run.report.check(
          `${size}: add a viewed photo to an album and reload its membership`,
          async () => {
            await tile(page, image).press("Enter");
            await page.waitForFunction(() => {
              const img = document.querySelector<HTMLImageElement>('[data-slot="lightbox"] img');

              return img !== null && img.complete && img.naturalWidth === 960;
            });
            await run.report.shot(page, `readiness-${size}-media-viewer`);
            await page.getByRole("button", { name: "Add to album", exact: true }).press("Enter");
            const release = run.front.hold((record) => record.operation === "photos.addToAlbum");

            try {
              await page
                .getByRole("menuitem", { name: `Memories ${size}`, exact: true })
                .press("Enter");
              // A slow mutation must still report success after the menu has closed.
              await page.getByRole("menu").waitFor({ state: "hidden" });
            } finally {
              release();
            }

            await page.getByText(`Added to Memories ${size}`, { exact: true }).waitFor();
            await closeViewer(page);
            await page.getByRole("link", { name: "Albums", exact: true }).click();
            await page.getByRole("link", { name: new RegExp(`^Memories ${size}`) }).click();
            await page.reload();
            await tile(page, image).waitFor();
            await run.report.shot(page, `readiness-${size}-album-with-photo`);
          },
        );
      } finally {
        await context.close();
      }
    },
  );
}

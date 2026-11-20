import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ownerPage, freshContext, openPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { downloadBytes, hydrated, rowMenu, uploadFiles } from "./page-actions.ts";
import { createLink, revokeLink } from "./scenarios-sharing.ts";
import {
  closeViewer,
  createFolder,
  openPhotos,
  tile,
  tileSelector,
  waitForTrayIdle,
} from "./scenarios-photos.ts";
import { PHONE } from "./scenarios-touch.ts";

/** A fresh disposable stack: completes phone actions whose desktop equivalents the default suite owns. */
export async function runPhoneCompletionScenarios(run: CoreRun) {
  await run.report.scenario("Phone completion: restore and public viewer link", async () => {
    const { context, page } = await ownerPage(run, PHONE);
    const guestContext = await freshContext(run, PHONE);
    const file = "phone-restorable.bin";
    const source = run.media.bytes(file, 3197);

    try {
      await createFolder(page, "Pictures");
      await uploadFiles(page, source);
      await waitForTrayIdle(run, page, 1);
      await run.report.check(
        "phone: trash and restore preserve the file's bytes and parent",
        async () => {
          await rowMenu(page, file, /Move to Trash/);
          await page.getByRole("link", { name: "Trash", exact: true }).first().click();
          await page.getByRole("button", { name: "Restore", exact: true }).focus();
          await page.keyboard.press("Enter");
          await page.getByText("Trash is empty", { exact: true }).waitFor();
          await page
            .getByRole("navigation", { name: "Main", exact: true })
            .last()
            .getByRole("link", { name: "Files", exact: true })
            .click();
          await page.getByRole("link", { name: /^Pictures/ }).click();
          await page.reload();
          await page.getByRole("button", { name: /^phone-restorable/ }).waitFor();
          assert.deepEqual(
            await downloadBytes(page, () => rowMenu(page, file, "Download")),
            readFileSync(source),
          );
          await run.report.shot(page, "phone-restored-file");
        },
      );
      const url = await createLink(page, file, "Viewer");
      const guest = await openPage(run, guestContext, new URL(url).pathname);
      await hydrated(guest);
      await run.report.check(
        "phone: anonymous password-free viewer link downloads exact bytes",
        async () => {
          await guest.getByRole("button", { name: "Open", exact: true }).tap();
          await guest.getByRole("heading", { name: file, exact: true }).waitFor();
          assert.deepEqual(
            await downloadBytes(guest, () =>
              guest.getByRole("button", { name: "Download", exact: true }).tap(),
            ),
            readFileSync(source),
          );
          await run.report.shot(guest, "phone-public-viewer-link");
        },
      );
      await run.report.check(
        "phone: revoking a public link ends the existing visitor's download access",
        async () => {
          await revokeLink(page, file);
          await guest.getByRole("button", { name: "Download", exact: true }).tap();
          await guest.getByRole("button", { name: "Open link again" }).first().waitFor();
          await run.report.shot(guest, "phone-public-revoked");
        },
      );
    } finally {
      await guestContext.close();
      await context.close();
    }
  });

  if (run.worker === null) {
    run.report.unverified(
      "phone: real thumbnail Retry and decoded video viewer",
      "Needs --worker; no mocked derivative or original-image fallback.",
    );

    return;
  }

  await run.report.scenario("Phone completion: real worker Retry and video viewer", async () => {
    const { context, page } = await ownerPage(run, PHONE);
    const photo = "phone-retry.png";
    const video = "phone-playback.mp4";

    const retry = (name: string) =>
      page.getByRole("button", { name: `Retry thumbnail of ${name}`, exact: true });

    try {
      run.stack.stopWorker();
      await page.getByRole("link", { name: /^Pictures/ }).click();
      await uploadFiles(page, [
        run.media.png(photo, 93),
        run.media.video(video, 6, [
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
        ]),
      ]);
      await waitForTrayIdle(run, page, 2);
      await openPhotos(page, photo);
      await run.report.check("phone: worker exhaustion exposes a real Retry control", async () => {
        await retry(photo).waitFor({ timeout: 240_000 });
        await retry(video).waitFor({ timeout: 240_000 });
        await run.report.shot(page, "phone-real-retry");
      });
      await run.report.check(
        "phone: keyboard Retry after worker recovery decodes image and poster",
        async () => {
          for (const name of [photo, video]) {
            await tile(page, name).focus();
            await page.keyboard.press("Tab");
            assert.equal(
              await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
              `Retry thumbnail of ${name}`,
            );
            await page.keyboard.press("Enter");
            await retry(name).waitFor({ state: "detached" });
          }

          await run.stack.startWorker();

          for (const name of [photo, video]) {
            await page.waitForFunction(
              (selector) => {
                const img = document.querySelector(selector)?.querySelector("img");

                return (
                  img !== null &&
                  img !== undefined &&
                  img.complete &&
                  img.naturalWidth > 0 &&
                  (img.getAttribute("src") ?? "").includes("/derivatives/")
                );
              },
              tileSelector(name),
              { timeout: 240_000 },
            );
          }

          await run.report.shot(page, "phone-retry-recovered");
        },
      );
      await run.report.check(
        "phone: video opens paused, then keyboard playback advances the original",
        async () => {
          await tile(page, video).tap();
          const player = page.locator('[data-slot="lightbox"] video');

          await player.waitFor();
          assert.equal(
            await player.evaluate(
              (element) => element instanceof HTMLVideoElement && element.paused,
            ),
            true,
          );
          await player.focus();
          await player.press("Space");
          await page.waitForFunction(() => {
            const video = document.querySelector<HTMLVideoElement>('[data-slot="lightbox"] video');

            return (
              video !== null &&
              video.error === null &&
              video.videoWidth === 320 &&
              video.currentTime > 0.1 &&
              video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              (video.getAttribute("src") ?? "").includes("/previews/")
            );
          });
          await run.report.shot(page, "phone-original-video-playing");
          await closeViewer(page);
        },
      );
    } finally {
      await run.stack.startWorker();
      await context.close();
    }
  });
}

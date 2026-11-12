import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { z } from "zod";
import { uploadFiles } from "./page-actions.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { ownerPage } from "./scenarios-core.ts";
import { chooseSources, createFolder, waitForTrayIdle } from "./scenarios-photos.ts";
import { audit, PHONE } from "./scenarios-touch.ts";

const TimelineReply = z.looseObject({
  value: z.looseObject({
    items: z.array(z.looseObject({ name: z.string(), previewUrl: z.string() })),
  }),
});

const FAILED_RETRYABLE = "red.avif";

type Identity = { readonly kind: "thumbnail" | "poster"; readonly sourceRevision: 1 };

const thumbnail: Identity = { kind: "thumbnail", sourceRevision: 1 };
const poster: Identity = { kind: "poster", sourceRevision: 1 };

/** One of each state a timeline item can report, assigned by name. Real files, injected states. */
function injectStates(body: string) {
  const reply = TimelineReply.parse(JSON.parse(body));
  const stillUrl = reply.value.items.find((item) => item.name === "red.png")?.previewUrl ?? "";
  const ready = { status: "ready", url: stillUrl, width: 256, height: 256 };

  const states = new Map(
    Object.entries({
      "red.png": { ...thumbnail, ...ready },
      "red.jpg": { ...thumbnail, status: "queued" },
      "red.webp": { ...thumbnail, status: "processing" },
      "red.gif": { ...thumbnail, status: "unavailable" },
      [FAILED_RETRYABLE]: { ...thumbnail, status: "failed", failure: "timeout", canRetry: true },
      "big.png": { ...thumbnail, status: "unsupported", failure: "resourceLimit" },
      "odd.png": { ...thumbnail, status: "unsupported", failure: "unsupported" },
      "broken.png": { ...thumbnail, status: "failed", failure: "invalidMedia", canRetry: false },
      "busy.png": { ...thumbnail, status: "failed", failure: "busy", canRetry: true },
      "red.mp4": { ...poster, ...ready },
      "red.webm": { ...poster, status: "queued" },
      "red.mov": { ...poster, status: "failed", failure: "unavailable", canRetry: true },
    }),
  );

  return JSON.stringify({
    ...reply,
    value: {
      ...reply.value,
      items: reply.value.items.map((item) => ({ ...item, derivative: states.get(item.name) })),
    },
  });
}

/** WCAG contrast of each caption against its tile, resolved by the browser itself. */
function captionContrasts(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });

    if (canvas === null) throw new Error("No canvas here.");

    const luminance = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);

      const [red = 0, green = 0, blue = 0] = canvas.getImageData(0, 0, 1, 1).data;

      const linear = (value: number) => {
        const channel = value / 255;

        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      };

      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };

    return [...document.querySelectorAll('[data-slot="media-tile-caption"]')].map((caption) => {
      const tile = caption.closest('[data-slot="media-tile"] button');
      const text = luminance(getComputedStyle(caption).color);
      const fill = luminance(getComputedStyle(tile ?? document.body).backgroundColor);

      return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
    });
  });
}

/** Captions that overlap their tile's Retry, or spill out of the tile. */
export function captionCollisions(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="media-tile-caption"]')].flatMap((caption) => {
      const text = caption.getBoundingClientRect();
      const frame = caption.closest('[data-slot="media-tile"]');
      const tile = frame?.getBoundingClientRect();
      const action = frame?.querySelector('button[aria-label^="Retry"]')?.getBoundingClientRect();
      const label = caption.textContent ?? "";

      const spills =
        tile !== undefined &&
        (text.top < tile.top ||
          text.bottom > tile.bottom ||
          text.left < tile.left ||
          text.right > tile.right);

      const overlaps =
        action !== undefined &&
        text.left < action.right &&
        text.right > action.left &&
        text.top < action.bottom &&
        text.bottom > action.top;

      return spills || overlaps ? [`${label}: ${spills ? "spills" : "under Retry"}`] : [];
    }),
  );
}

function tileNamed(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) });
}

/**
 * Layout and interaction of every thumbnail state, in a real browser through the real host. States
 * are injected at the gateway because the image under test has no worker. This says nothing about
 * how a worker reaches them, what its thumbnails look like, or how fast anything is.
 */
export async function runThumbnailStateScenario(run: CoreRun) {
  const { report, media, front } = run;

  await report.scenario("Thumbnail states (injected, layout and interaction only)", async () => {
    const { context, page } = await ownerPage(run, { colorScheme: "light" });

    const files = [
      ...["png", "jpg", "webp", "gif", "avif", "mp4", "webm", "mov"].map((extension) =>
        media.fixture(extension),
      ),
      ...["big", "odd", "broken", "busy"].map((name, seed) =>
        media.png(`${name}.png`, seed + 2, "320x240"),
      ),
    ];

    await createFolder(page, "Pictures");
    await uploadFiles(page, files);
    await waitForTrayIdle(run, page, files.length);
    await chooseSources(run, page);

    front.rewriteReplies((record) => record.operation === "photos.timeline", injectStates);
    // Leave first, so images the previous page was still loading can't count against this one.
    await page.goto("about:blank");
    await page.waitForTimeout(300);
    front.resetCounters();
    await page.goto(new URL("/photos", run.origin).href);
    await tileNamed(page, "red.png").waitFor();
    await page
      .getByRole("button", { name: /\. Preparing thumbnail\.$/ })
      .first()
      .waitFor();
    await page.waitForTimeout(1000);
    await report.shot(page, "thumbnail-states-desktop-light");

    await report.check("no tile without a ready thumbnail downloads its original", async () => {
      const previews = front.records.filter((record) =>
        record.path.startsWith("/api/storage/previews/"),
      );

      report.observe("preview requests with every thumbnail state on screen", {
        requests: previews.length,
        distinctUrls: new Set(previews.map((record) => record.path)).size,
        paths: previews.map((record) => record.path),
        tiles: files.length,
      });
      // The two ready tiles both point at one still here, so one file serves them.
      assert.equal(new Set(previews.map((record) => record.path)).size, 1);
    });

    await report.check("the timeline makes no request per tile", async () => {
      const perTile = front.records.filter((record) => record.operation === "media.get");

      assert.equal(perTile.length, 0);
      assert.equal(
        front.records.filter((record) => record.operation === "media.retry").length,
        0,
        "nothing was retried before being asked",
      );
    });

    await report.check("Tab reaches a tile's Retry, and a focus ring shows on it", async () => {
      await tileNamed(page, "red.avif").focus();
      await page.keyboard.press("Tab");

      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

      assert.equal(focused, `Retry thumbnail of ${FAILED_RETRYABLE}`);
      await report.shot(page, "thumbnail-states-retry-focus");
    });

    await report.check("Retry doesn't open the photo, and a refusal says so", async () => {
      await page.getByRole("button", { name: `Retry thumbnail of ${FAILED_RETRYABLE}` }).click();
      // This image predates the operation, so the real backend's refusal is what's being shown.
      await page.getByText("Couldn’t retry", { exact: true }).waitFor();
      assert.equal(await page.locator('[data-slot="lightbox"]').count(), 0);
      assert.equal(front.records.filter((record) => record.operation === "media.retry").length, 1);
      await report.shot(page, "thumbnail-states-retry-refused");
    });

    await report.check("a tile with no thumbnail still opens its original", async () => {
      await tileNamed(page, "broken.png").click();
      await page.locator('[data-slot="lightbox"]').waitFor();
      await page.keyboard.press("Escape");
      await page.locator('[data-slot="lightbox"]').waitFor({ state: "detached" });
    });

    await report.check("captions meet 4.5:1 in light", async () => {
      const contrasts = await captionContrasts(page);

      report.observe("lowest caption contrast, light", Math.min(...contrasts));
      assert.ok(Math.min(...contrasts) >= 4.5, `lowest is ${Math.min(...contrasts)}`);
    });

    await page.emulateMedia({ colorScheme: "dark" });
    await report.shot(page, "thumbnail-states-desktop-dark");

    await report.check("captions meet 4.5:1 in dark", async () => {
      const contrasts = await captionContrasts(page);

      report.observe("lowest caption contrast, dark", Math.min(...contrasts));
      assert.ok(Math.min(...contrasts) >= 4.5, `lowest is ${Math.min(...contrasts)}`);
    });

    await context.close();

    for (const colorScheme of ["light", "dark"] as const) {
      const phone = await ownerPage(run, { ...PHONE, colorScheme });

      await phone.page.goto(new URL("/photos", run.origin).href);
      await tileNamed(phone.page, "red.png").waitFor();
      await phone.page.waitForTimeout(800);
      await report.shot(phone.page, `thumbnail-states-phone-${colorScheme}`);

      if (colorScheme === "light") {
        await audit(run, phone.page, "Thumbnail states");
        await report.check(
          "on a phone, the backlog summary stays one tidy line in the bar",
          async () => {
            const summary = phone.page.getByText(/loaded items?$/);

            await summary.waitFor();

            const box = await summary.boundingBox();

            assert.ok(box !== null && box.height <= 20, `${box?.height}px tall`);
            assert.ok(box !== null && box.x >= 0 && box.x + box.width <= 390, "overflows");
          },
        );
        await report.check(
          "on touch, captions stay clear of Retry and inside the tile",
          async () => {
            assert.deepEqual(await captionCollisions(phone.page), []);
          },
        );
      }

      await phone.context.close();
    }

    front.clearFaults();
  });
}

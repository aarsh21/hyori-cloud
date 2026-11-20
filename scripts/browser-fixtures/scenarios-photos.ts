import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { accountPassword, addUser, openUsers } from "./scenarios-admin.ts";
import { MEDIA_FORMATS } from "./media.ts";
import { chooseWith, rowMenu, signIn, uploadFiles, uploadsTray } from "./page-actions.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import type { Observed } from "./run-report.ts";

const LONG_TIMELINE_COPIES = 15;

// Generous: the backend claims one job per 5 second pass, however many are waiting.
const THUMBNAIL_TIMEOUT_MS = 240_000;

const isOriginal = ({ path }: { readonly path: string }) =>
  path.startsWith("/api/storage/previews/");

const isThumbnail = ({ path }: { readonly path: string }) =>
  path.startsWith("/api/storage/derivatives/");

export async function createFolder(page: Page, name: string) {
  await page.getByRole("button", { name: "New folder" }).first().click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("heading", { name }).waitFor();
}

/**
 * Waits for everything queued to commit. Ordinary new files have no reason to conflict, so one that
 * does is recorded as a failure before being recovered the way a person would, with Retry.
 */
export async function waitForTrayIdle(run: CoreRun, page: Page, expected: number) {
  const tray = uploadsTray(page);
  const deadline = Date.now() + 300_000;
  const failedRows = new Set<string | null>();
  let clicks = 0;

  while (Date.now() < deadline) {
    const heading = (await tray.locator("h2").textContent()) ?? "";

    if (heading.startsWith(`${expected} `) && heading.includes("complete")) break;

    // Not one already pressed: that stays on screen, inert, until the queue has a slot for it.
    const retry = tray.locator('button[aria-label^="Retry upload of"]:not([aria-busy="true"])');

    if ((await retry.count()) > 0) {
      await assertRowsDontOverlap(run, page);

      const failure = await retry.first().evaluate((button) => {
        const row = button.closest('[data-slot="transfer-item"]');

        return {
          at: Date.now(),
          fileName: button.getAttribute("aria-label")?.slice("Retry upload of ".length) ?? null,
          errorText: row?.querySelector("p.text-destructive")?.textContent ?? null,
          rowText: row?.textContent ?? null,
          url: location.href,
        };
      });

      run.report.observe(`manual upload retry ${failure.fileName} at ${failure.at}`, failure);
      failedRows.add(await retry.first().getAttribute("aria-label"));
      await retry.first().click();
      clicks += 1;
    }

    await page.waitForTimeout(500);
  }

  // Clicks beyond the rows are a row failing again, now that a pressed Retry can't be pressed twice.
  if (failedRows.size > 0) {
    run.report.record(
      "a batch of new files commits without spurious conflicts",
      "fail",
      `${failedRows.size} rows needed a manual retry, after ${clicks} clicks`,
    );
  }

  await tray.getByRole("button", { name: "Clear" }).click();
  await tray.waitFor({ state: "detached" });

  return failedRows.size;
}

async function assertRowsDontOverlap(run: CoreRun, page: Page) {
  await run.report.check("tray rows never overlap, however many there are", async () => {
    const overlaps = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-slot="transfer-item"]')];
      let count = 0;

      for (const [index, row] of rows.entries()) {
        const next = rows[index + 1];

        if (next === undefined) continue;

        // What the row's own content needs, not only the box it was given.
        if (row.scrollHeight > row.clientHeight + 1) count += 1;

        if (row.getBoundingClientRect().bottom > next.getBoundingClientRect().top + 1) count += 1;
      }

      return count;
    });

    assert.equal(overlaps, 0);
  });
}

/** A tile's label is its file's name, then a sentence about its thumbnail if there's anything to say. */
export function tile(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return page.getByRole("button", { name: new RegExp(`^${escaped}(\\. |$)`) });
}

export function tileSelector(name: string) {
  return `button[aria-label="${name}"], button[aria-label^="${name}. "]`;
}

function tileImageState(page: Page, name: string) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    const image = button?.querySelector("img");

    if (button === null || button === undefined) return { present: false, decoded: false };

    return {
      present: true,
      src: image?.getAttribute("src") ?? null,
      decoded: image !== null && image !== undefined && image.complete && image.naturalWidth > 0,
      width: image?.naturalWidth ?? 0,
    };
  }, tileSelector(name));
}

type StageState =
  | {
      readonly kind: "image";
      readonly naturalWidth: number;
      readonly src: string | null;
      readonly message: string | null;
    }
  | {
      readonly kind: "video";
      readonly readyState: number;
      readonly width: number;
      readonly duration: number;
      readonly errorCode: number;
      readonly src: string | null;
      readonly message: string | null;
    }
  | { readonly kind: "message"; readonly message: string | null };

/** What the browser's real decoder does with what's on the viewer's stage right now. */
export function stageState(page: Page) {
  return page.evaluate(async (): Promise<StageState> => {
    const stage = document.querySelector('[data-slot="lightbox"]');
    const image = stage?.querySelector("img");
    const video = stage?.querySelector("video");
    const message = stage?.querySelector('[role="alert"]')?.textContent ?? null;

    if (image !== null && image !== undefined) {
      if (!image.complete) {
        await new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 8000);
        });
      }

      return {
        kind: "image",
        naturalWidth: image.naturalWidth,
        src: image.getAttribute("src"),
        message,
      };
    }

    if (video !== null && video !== undefined) {
      if (video.readyState < 2 && video.error === null) {
        await new Promise((resolve) => {
          video.addEventListener("loadeddata", resolve, { once: true });
          video.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 8000);
        });
      }

      return {
        kind: "video",
        readyState: video.readyState,
        width: video.videoWidth,
        duration: Number.isFinite(video.duration) ? video.duration : -1,
        errorCode: video.error?.code ?? 0,
        src: video.getAttribute("src"),
        message,
      };
    }

    return { kind: "message", message: stage?.textContent?.trim().slice(0, 160) ?? null };
  });
}

export async function closeViewer(page: Page) {
  await page.getByRole("button", { name: "Close viewer" }).click();
  await page.locator('[data-slot="lightbox"]').waitFor({ state: "detached" });
}

async function seedLibrary(run: CoreRun, page: Page) {
  const { media } = run;

  await createFolder(page, "Pictures");

  const files = [
    ...MEDIA_FORMATS.map((format) => media.fixture(format.extension)),
    media.video("long-h264.mp4", 12, [
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ]),
    media.video("long-vp9.webm", 12, ["-c:v", "libvpx-vp9", "-b:v", "300k"]),
    media.video("long-h264.mov", 12, [
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ]),
    media.video("long-hevc.mp4", 4, ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]),
    media.bytes("not-really.png", 4096),
    media.png("swap.png", 1, "960x720"),
  ];

  await uploadFiles(page, files);
  await waitForTrayIdle(run, page, files.length);
}

/**
 * Opens Photos, where the library needs no setup: media this account owns is already there, wherever
 * in Files it lives.
 */
export async function openPhotos(page: Page, expectedTile = "red.png") {
  await page.getByRole("link", { name: "Photos" }).first().click();
  await tile(page, expectedTile).waitFor();
}

/**
 * Without a worker the server reports thumbnails as unavailable. No tile may then cost a download
 * of its original: every tile stays an honest placeholder, and only opening one loads media.
 */
async function originalTiles({ report, front }: CoreRun, page: Page) {
  await report.check(
    "without thumbnails, tiles stay placeholders and download nothing",
    async () => {
      front.resetCounters();

      for (const format of MEDIA_FORMATS) {
        const name = `red.${format.extension}`;

        await tile(page, name).scrollIntoViewIfNeeded();
        await page.waitForFunction((label) => {
          const button = document.querySelector(`button[aria-label="${label}"]`);

          return button?.querySelector("img") === null && button.querySelector("svg") !== null;
        }, name);
      }

      const previews = front.records.filter((record) =>
        record.path.startsWith("/api/storage/previews/"),
      );

      assert.equal(previews.length, 0, "tiles requested originals");
    },
  );

  await report.shot(page, "photos-timeline-desktop");

  await report.check(
    "a file whose bytes aren't what it claims falls back, without a broken image",
    async () => {
      await tile(page, "not-really.png").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="not-really.png"]');

        return (
          button !== null &&
          button.querySelector("img") === null &&
          button.querySelector("svg") !== null
        );
      });
      await tile(page, "not-really.png").click();
      await page.getByText(/This can’t be previewed here/).waitFor();
      await closeViewer(page);
    },
  );
}

/** Waits for a tile to stop preparing, then says what it ended up showing. */
async function thumbnailOutcome(page: Page, name: string) {
  await tile(page, name).scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (selector) => {
      const button = document.querySelector(selector);
      // A ready tile behind others' loads has no <img> yet, but says one is coming.
      const image = button?.querySelector('[data-slot="media-tile-image"]');

      if (button === null || button === undefined) return false;

      if (image !== null && image !== undefined) {
        return image instanceof HTMLImageElement && image.complete;
      }

      return !(button.getAttribute("aria-label") ?? "").includes("Preparing");
    },
    tileSelector(name),
    { timeout: THUMBNAIL_TIMEOUT_MS },
  );

  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    const image = button?.querySelector("img");

    return {
      label: button?.getAttribute("aria-label") ?? null,
      src: image?.getAttribute("src") ?? null,
      width: image?.naturalWidth ?? 0,
      height: image?.naturalHeight ?? 0,
      badge: button?.querySelector('[data-slot="media-tile-badge"]') != null,
    };
  }, tileSelector(name));
}

/** Every format through the real worker. What HEVC does is recorded, not assumed either way. */
async function thumbnailTiles({ report, front }: CoreRun, page: Page) {
  const outcomes: Record<string, Observed> = {};

  front.resetCounters();
  await page.reload();
  await tile(page, "red.png").waitFor();

  await report.check("every format's tile reaches its real thumbnail or poster", async () => {
    for (const format of MEDIA_FORMATS) {
      const name = `red.${format.extension}`;
      const outcome = await thumbnailOutcome(page, name);

      outcomes[name] = outcome;
      assert.match(
        String(outcome.src),
        /^\/api\/storage\/derivatives\//,
        `${name}: ${outcome.label}`,
      );
      assert.ok(outcome.width > 0 && outcome.width <= 384, `${name} is ${outcome.width} wide`);
      assert.ok(outcome.height > 0 && outcome.height <= 384, `${name} is ${outcome.height} high`);
      assert.equal(outcome.badge, format.mimeType.startsWith("video/"), `${name}'s video badge`);
    }
  });

  for (const name of ["long-h264.mp4", "long-vp9.webm", "long-h264.mov", "long-hevc.mp4"]) {
    outcomes[name] = await thumbnailOutcome(page, name);
  }

  report.observe("worker results per format (this worker image only)", outcomes);
  await report.shot(page, "photos-timeline-desktop");

  await report.check("browsing thumbnails downloads no original", () => {
    assert.deepEqual(
      front.records.filter(isOriginal).map(({ path }) => path),
      [],
    );
  });

  await report.check(
    "a file whose bytes aren't what it claims says so, with no Retry",
    async () => {
      const outcome = await thumbnailOutcome(page, "not-really.png");

      assert.equal(outcome.label, "not-really.png. Couldn’t read this file.");
      assert.equal(outcome.src, null);
      await tile(page, "not-really.png").click();
      await page.getByText(/This can’t be previewed here/).waitFor();
      await closeViewer(page);
    },
  );

  await report.check("reloading many ready thumbnails stays within six at a time", async () => {
    front.resetCounters();
    await page.reload();
    await thumbnailOutcome(page, "red.png");
    await page.waitForTimeout(1500);

    const loads = front.records.filter(isThumbnail);

    report.observe("thumbnail reload", {
      requests: loads.length,
      peakInFlight: front.peakInFlightTileMedia(),
      protocol: loads[0]?.protocol ?? "none",
      bytes: loads.reduce((sum, record) => sum + record.bytes, 0),
    });
    assert.ok(loads.length > 0, "nothing loaded");
    assert.ok(front.peakInFlightTileMedia() <= 6, `peak ${front.peakInFlightTileMedia()}`);
  });
}

async function tilesAndViewer(run: CoreRun, page: Page) {
  const { report, front } = run;
  const decoders: Record<string, Observed> = {};

  if (run.worker === null) await originalTiles(run, page);
  else await thumbnailTiles(run, page);

  for (const name of [
    ...MEDIA_FORMATS.map((format) => `red.${format.extension}`),
    "long-h264.mp4",
    "long-vp9.webm",
    "long-h264.mov",
    "long-hevc.mp4",
  ]) {
    await tile(page, name).click();

    const state = await stageState(page);

    decoders[name] = state;

    if (state.kind !== "message" && state.src !== null) {
      assert.match(state.src, /^\/api\/storage\/previews\//, `${name}'s viewer isn't the original`);
    }

    if (state.kind === "video" && state.errorCode !== 0) {
      await page.getByText(/This can’t be previewed here/).waitFor();
    }

    // Whether a frame really painted can't be read back reliably, so each one gets looked at.
    if (name.startsWith("long-")) await report.shot(page, `viewer-${name.replace(".", "-")}`);

    await closeViewer(page);
  }

  report.observe("decoder results per format (Chromium, this build only)", decoders);

  await report.check("a playable video seeks, using real range requests", async () => {
    front.resetCounters();
    await tile(page, "long-h264.mp4").click();

    const seek = await page.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('[data-slot="lightbox"] video');

      if (video === null) return { error: "no video", currentTime: 0, duration: 0 };

      if (video.readyState < 1) {
        await new Promise((resolve) => {
          video.addEventListener("loadedmetadata", resolve, { once: true });
          video.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 8000);
        });
      }

      if (video.error !== null) {
        return { error: `decode ${video.error.code}`, currentTime: 0, duration: 0 };
      }

      video.currentTime = 8;

      await new Promise((resolve) => {
        video.addEventListener("seeked", resolve, { once: true });
        setTimeout(resolve, 8000);
      });

      return { error: "", currentTime: video.currentTime, duration: video.duration };
    });

    const requests = front.records
      .filter((record) => record.path.startsWith("/api/storage/previews/"))
      .map((record) => ({
        status: record.status,
        range: record.range,
        contentRange: record.contentRange,
        contentLength: record.contentLength,
      }));

    report.observe("video seek and its requests", { seek, requests });
    assert.equal(seek.error, "", seek.error);
    assert.ok(seek.currentTime >= 7, `didn't seek: ${seek.currentTime}`);
    await closeViewer(page);
  });
}

async function ranges(run: CoreRun, page: Page) {
  const { report } = run;

  await tile(page, "long-h264.mp4").click();

  const state = await stageState(page);

  await closeViewer(page);

  const src = state.kind === "video" ? state.src : null;

  assert.ok(src !== null, "the viewer's video has no source");

  await report.check(
    "the preview answers 200, 206, 304 and 416 honestly, inline and revalidated",
    async () => {
      // From the page, as the app's own code would: outside it the server rightly refuses the origin.
      const results = await page.evaluate(async (target) => {
        const read = async (range: string | null) => {
          const response = await fetch(target, range === null ? {} : { headers: { Range: range } });
          const body = await response.arrayBuffer();

          return {
            status: response.status,
            bytes: body.byteLength,
            contentLength: response.headers.get("content-length"),
            contentRange: response.headers.get("content-range"),
            acceptRanges: response.headers.get("accept-ranges"),
            contentDisposition: response.headers.get("content-disposition"),
            contentType: response.headers.get("content-type"),
            cacheControl: response.headers.get("cache-control"),
            etag: response.headers.get("etag"),
            contentTypeOptions: response.headers.get("x-content-type-options"),
          };
        };

        const whole = await read(null);
        const conditional = await fetch(target, { headers: { "If-None-Match": whole.etag! } });

        return {
          whole,
          conditional: {
            status: conditional.status,
            bytes: (await conditional.arrayBuffer()).byteLength,
          },
          part: await read("bytes=0-99"),
          open: await read("bytes=100-"),
          beyond: await read("bytes=999999999-"),
        };
      }, src);

      report.observe("preview range responses", results);
      assert.equal(results.whole.status, 200, "whole file");
      assert.equal(results.part.status, 206, "a closed range");
      assert.equal(results.part.bytes, 100, "bytes in a closed range");
      assert.equal(results.open.status, 206, "an open range");
      assert.equal(results.open.bytes, results.whole.bytes - 100, "bytes in an open range");
      assert.equal(results.beyond.status, 416, "a range past the end");
      assert.equal(results.whole.cacheControl, "private, no-cache");
      assert.ok(results.whole.etag);
      assert.equal(results.conditional.status, 304);
      assert.equal(results.conditional.bytes, 0);
      assert.equal(results.whole.contentTypeOptions, "nosniff");
      assert.match(results.whole.contentDisposition ?? "", /^inline/);
    },
  );
}

async function revisionFreshness(run: CoreRun, page: Page, freshImage: boolean) {
  const { report, media } = run;

  if (!freshImage) {
    report.unverified("preview identity after replace and restore", "needs --fresh-image");

    return;
  }

  const swap = "swap.png";

  /** Tiles may be scaled down, so a replacement is told apart by aspect ratio, on a new URL. */
  const tileHasAspect = (widthOverHeight: number) =>
    page.waitForFunction(
      ({ selector, ratio, thumbnail }) => {
        const image = document.querySelector(selector)?.querySelector("img");

        if (image === null || image === undefined || !image.complete || image.naturalHeight === 0) {
          return false;
        }

        if (thumbnail && !(image.getAttribute("src") ?? "").includes("/derivatives/")) return false;

        return Math.abs(image.naturalWidth / image.naturalHeight - ratio) < 0.02;
      },
      { selector: tileSelector(swap), ratio: widthOverHeight, thumbnail: run.worker !== null },
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );

  /**
   * What this photo shows, and under which URL: its thumbnail with a worker. Without one, tiles are
   * placeholders by design, so the viewer, which is where the original bytes are seen, answers.
   */
  const showing = async (widthOverHeight: number) => {
    await tile(page, swap).scrollIntoViewIfNeeded();

    if (run.worker !== null) {
      await tileHasAspect(widthOverHeight);

      return tileImageState(page, swap);
    }

    await tile(page, swap).click();
    await page.waitForFunction(
      (ratio) => {
        const image = document.querySelector('[data-slot="lightbox"] img');

        return (
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalHeight > 0 &&
          Math.abs(image.naturalWidth / image.naturalHeight - ratio) < 0.02
        );
      },
      widthOverHeight,
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );

    const src = await page.locator('[data-slot="lightbox"] img').getAttribute("src");

    await closeViewer(page);

    return { src };
  };

  const first = await showing(960 / 720);
  const sources: string[] = [String(first.src)];
  const bigger = media.png("swap replacement.png", 2, "640x640");

  await report.check("the photo's URL carries a server revision", () => {
    assert.match(String(first.src), /[?&]revision=\d+/);
  });

  await page.getByRole("link", { name: "Files" }).first().click();
  await page.getByRole("link", { name: /^Pictures/ }).click();
  await rowMenu(page, swap, "Upload new version…");

  const dialog = page.getByRole("dialog");

  await chooseWith(
    page,
    () => dialog.getByRole("button", { name: "Choose file…" }).click(),
    bigger,
  );
  await dialog.getByRole("button", { name: "Upload new version" }).click();
  await uploadsTray(page).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
  await uploadsTray(page).getByRole("button", { name: "Clear" }).click();

  const backToPhotos = async () => {
    await page.getByRole("link", { name: "Photos" }).first().click();
    await tile(page, swap).scrollIntoViewIfNeeded();
  };

  await report.check(
    "after replacing, the same photo shows the new bytes under a new URL",
    async () => {
      await backToPhotos();

      const replaced = await showing(1);

      assert.notEqual(replaced.src, first.src, "the URL didn't change");
      sources.push(String(replaced.src));
    },
  );

  if (run.worker !== null) {
    await report.check("a replaced source's old thumbnail URL stops working", async () => {
      const status = await page.evaluate(
        async (url) => (await fetch(url)).status,
        String(first.src),
      );

      assert.ok(status >= 400, `answered ${status}`);
    });
  }

  await report.check("the viewer agrees with the tile", async () => {
    await tile(page, swap).click();

    const state = await stageState(page);

    assert.equal(state.kind, "image");
    assert.ok("naturalWidth" in state && state.naturalWidth === 640, "viewer shows old bytes");
    await closeViewer(page);
  });

  await report.check("restoring brings the old bytes back under another new URL", async () => {
    await page.getByRole("link", { name: "Files" }).first().click();
    await page.getByRole("link", { name: /^Pictures/ }).click();
    await rowMenu(page, swap, "Version history…");

    const history = page.getByRole("dialog");

    await history.getByRole("button", { name: "Restore" }).first().click();
    await page.getByText(/Restored the version from/).waitFor();
    await history.getByRole("button", { name: "Close" }).click();
    await backToPhotos();

    const restored = await showing(960 / 720);

    sources.push(String(restored.src));
    assert.equal(
      new Set(sources).size,
      3,
      `expected three distinct URLs, got ${sources.join(", ")}`,
    );
  });

  report.observe("preview URLs across replace and restore", sources);
}

async function longTimeline(run: CoreRun, context: BrowserContext, page: Page) {
  const { report, front, media } = run;

  await page.getByRole("link", { name: "Files" }).first().click();
  await page.getByRole("link", { name: /^Pictures/ }).click();

  const patterns = Array.from({ length: 8 }, (_, index) =>
    media.png(`pattern-${index}.png`, index, "800x600"),
  );

  const files = Array.from({ length: LONG_TIMELINE_COPIES * patterns.length }, (_, index) => {
    const copy = join(media.directory, `timeline-${String(index).padStart(3, "0")}.png`);

    copyFileSync(patterns[index % patterns.length]!, copy);

    return copy;
  });

  await uploadFiles(page, files);
  await waitForTrayIdle(run, page, files.length);

  const cdp = await context.newCDPSession(page);

  await cdp.send("Performance.enable");

  const metrics = async () => {
    const { metrics: values } = await cdp.send("Performance.getMetrics");
    const value = (name: string) => values.find((metric) => metric.name === name)?.value ?? 0;

    return {
      jsHeapUsedMb: Math.round(value("JSHeapUsedSize") / 1024 / 1024),
      domNodes: value("Nodes"),
      tilesMounted: await page.locator('[data-slot="media-tile"]').count(),
      imagesLoaded: await page.evaluate(
        () => document.querySelectorAll('[data-slot="media-tile"] img').length,
      ),
    };
  };

  await page.getByRole("link", { name: "Photos" }).first().click();
  front.resetCounters();
  await page.reload();
  await page.locator('[data-slot="media-tile"]').first().waitFor();
  await page.waitForTimeout(4000);

  const top = await metrics();
  const atTop = front.records.filter((record) => isOriginal(record) || isThumbnail(record));
  const failed = atTop.filter((record) => record.status >= 400);

  report.observe("timeline at the top", {
    ...top,
    tileRequests: atTop.length,
    originals: atTop.filter(isOriginal).length,
    thumbnails: atTop.filter(isThumbnail).length,
    failures: failed.map((record) => record.status),
    peakInFlightTileMedia: front.peakInFlightTileMedia(),
    protocol: atTop[0]?.protocol ?? "none",
    megabytes: Math.round(atTop.reduce((sum, record) => sum + record.bytes, 0) / 1024 / 1024),
    libraryRequests: front.records.filter((record) => record.operation === "photos.library").length,
  });

  await report.check("no tile load is refused at the top of a long timeline", () => {
    assert.deepEqual(
      atTop.filter((record) => record.status >= 500).map((record) => record.status),
      [],
    );
  });

  await report.check("the client never has more than six tile loads in flight", () => {
    assert.ok(front.peakInFlightTileMedia() <= 6, `peak ${front.peakInFlightTileMedia()}`);
  });

  if (run.worker !== null) {
    await report.check("a long timeline in progress downloads no originals to browse", () => {
      assert.equal(atTop.filter(isOriginal).length, 0);
    });
  }

  if (run.worker !== null) {
    await report.check("a long backlog shows one summary, scoped to what's loaded", async () => {
      await page.getByText(/^Preparing .+ of \d+ loaded items?$/).waitFor();
      assert.equal(await page.getByText("Preparing thumbnail", { exact: true }).count(), 0);
    });
  }

  await report.check("no metadata request per tile", () => {
    assert.equal(
      front.records.filter((record) => record.operation === "files.preview").length,
      0,
      "files.preview calls while browsing tiles",
    );
    assert.equal(front.records.filter((record) => record.operation === "files.get").length, 0);
  });

  const scroller = page.locator('[data-slot="page-body"]');

  for (let step = 0; step < 6; step += 1) {
    await scroller.evaluate((element) => element.scrollBy(0, element.clientHeight * 1.5));
    await page.waitForTimeout(700);
  }

  await page.waitForTimeout(3000);

  const scrolled = await metrics();

  const afterScroll = front.records.filter((record) => isOriginal(record) || isThumbnail(record));

  report.observe("timeline after scrolling", {
    ...scrolled,
    tileRequests: afterScroll.length,
    originals: afterScroll.filter(isOriginal).length,
    thumbnails: afterScroll.filter(isThumbnail).length,
    failures: afterScroll.filter((record) => record.status >= 400).map((record) => record.status),
    aborted: afterScroll.filter((record) => record.outcome === "aborted").length,
    peakInFlightTileMedia: front.peakInFlightTileMedia(),
    megabytes: Math.round(afterScroll.reduce((sum, record) => sum + record.bytes, 0) / 1024 / 1024),
  });

  await report.shot(page, "photos-long-timeline-scrolled");

  await report.check("scrolling keeps the rendered window bounded", () => {
    assert.ok(scrolled.tilesMounted < files.length, `${scrolled.tilesMounted} tiles mounted`);
  });

  await report.check("no tile failed while scrolling", () => {
    assert.deepEqual(
      afterScroll.filter((record) => record.status >= 500).map((record) => record.status),
      [],
    );
  });

  await scroller.evaluate((element) => element.scrollTo(0, 0));

  if (run.worker !== null) await thumbnailProgress(run, page);
}

/** How fast thumbnails really arrive, and what watching for them costs. Measured, not a promise. */
async function thumbnailProgress({ report, front, stack }: CoreRun, page: Page) {
  const ready = () =>
    Number(stack.sql("SELECT count(*) FROM hyori_media_jobs WHERE state='ready'"));

  const waiting = () =>
    Number(
      stack.sql("SELECT count(*) FROM hyori_media_jobs WHERE state IN ('queued','processing')"),
    );

  const readyBefore = ready();
  const seconds = 60;

  front.resetCounters();
  await page.waitForTimeout(seconds * 1000);

  const libraryReads = front.records.filter(({ operation }) => operation === "photos.library");

  report.observe("thumbnails arriving while a timeline is open", {
    seconds,
    finished: ready() - readyBefore,
    stillWaiting: waiting(),
    libraryReads: libraryReads.length,
    libraryReadBytes: libraryReads.reduce((sum, record) => sum + record.bytes, 0),
  });
}

async function neighbourPreload(run: CoreRun, context: BrowserContext, page: Page) {
  const { report, front } = run;

  const measure = async (target: Page, label: string) => {
    await target.reload();
    await target.locator('[data-slot="media-tile"] button').first().waitFor();
    await target.waitForTimeout(1500);
    front.resetCounters();
    await target.locator('[data-slot="media-tile"] button').first().click();
    await target.locator('[data-slot="lightbox"]').waitFor();

    // Far enough to pass everything the tiles had already loaded.
    for (let index = 0; index < 40; index += 1) {
      await target.keyboard.press("ArrowRight");
      await target.waitForTimeout(350);
    }

    const requests = front.records.filter(
      (record) => record.path.startsWith("/api/storage/previews/") && record.method === "GET",
    );

    const counts = new Map<string, number>();

    for (const record of requests) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);

    report.observe(`neighbour preload: ${label}`, {
      steps: 40,
      requests: requests.length,
      distinctUrls: counts.size,
      repeatedRequests: requests.length - counts.size,
      abortedRequests: requests.filter((record) => record.outcome === "aborted").length,
      megabytes: Number(
        (requests.reduce((sum, record) => sum + record.bytes, 0) / 1024 / 1024).toFixed(2),
      ),
      cacheControl: requests[0]?.cacheControl ?? null,
    });

    await closeViewer(target);
  };

  await measure(page, "default");

  const saving = await context.newPage();

  await saving.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { value: { saveData: true } });
  });
  await saving.goto(page.url());
  await measure(saving, "browser asks to save data");
  await saving.close();
}

/**
 * A folder shared with someone else never joins their library: Photos reads only what each account
 * owns, and the share stays where it was made, in Shared with me.
 */
async function sharedFolderStaysOutOfLibrary(run: CoreRun) {
  const { report, media } = run;
  const { context: ownerContext, page: owner } = await ownerPage(run);
  const email = "tala@example.test";
  const password = accountPassword();

  await openUsers(owner);
  await addUser(owner, "Tala Moana", email, password);

  const friendContext = await freshContext(run);
  const friend = await openPage(run, friendContext);

  await signIn(friend, email, password);
  await friend.getByText("No files yet").waitFor();
  await friend.getByRole("button", { name: /Tala Moana/ }).click();
  await friend.getByRole("menuitem", { name: "Your account ID" }).click();

  const accountId = await friend.getByRole("textbox", { name: "Account ID" }).inputValue();

  await friend.getByRole("button", { name: "Done" }).click();

  await owner.getByRole("link", { name: "Files" }).first().click();
  await createFolder(owner, "Holiday");
  await uploadFiles(owner, media.png("beach.png", 7, "640x480"));
  await owner.getByRole("button", { name: /^beach\.png/ }).waitFor({ timeout: 30_000 });
  await waitForTrayIdle(run, owner, 1);
  await owner.getByRole("link", { name: "Files" }).first().click();
  await rowMenu(owner, "Holiday", "Share…");

  const shareDialog = owner.getByRole("dialog");

  await shareDialog.getByLabel("Account ID").fill(accountId);
  await shareDialog.getByRole("button", { name: "Add" }).click();
  await shareDialog.getByRole("list", { name: "People with access" }).waitFor();
  await report.shot(owner, "share-dialog-person");

  await report.check("media shared with someone stays out of their library", async () => {
    await friend.getByRole("link", { name: "Photos" }).first().click();
    await friend.getByText("No photos yet").waitFor();
    assert.equal(await tile(friend, "beach.png").count(), 0, "shared media in the library");
  });

  await report.shot(friend, "photos-shared-not-in-library");

  // The share itself stays reachable where it was made, and its media opens from there.
  await friend.getByRole("button", { name: "Shared with me" }).click();
  await friend.getByRole("link", { name: "Holiday" }).waitFor();

  await shareDialog.getByRole("button", { name: "Remove" }).click();
  await shareDialog
    .getByRole("list", { name: "People with access" })
    .waitFor({ state: "detached" });
  await shareDialog.getByRole("button", { name: "Done" }).click();

  await report.check("after the share ends, a reload shows nothing of it", async () => {
    await friend.reload();
    await friend.getByText("No photos yet").waitFor();
    assert.equal(await tile(friend, "beach.png").count(), 0, "shared media still shown");
  });

  await friendContext.close();
  await ownerContext.close();
}

async function ownLibrary(run: CoreRun, freshImage: boolean) {
  const { report } = run;
  const { context, page } = await ownerPage(run);

  await seedLibrary(run, page);
  await openPhotos(page);
  await tilesAndViewer(run, page);
  await ranges(run, page);
  await report.shot(page, "photos-timeline-after-viewing");
  await revisionFreshness(run, page, freshImage);
  await longTimeline(run, context, page);
  await neighbourPreload(run, context, page);
  await context.close();
}

export async function runPhotoScenarios(run: CoreRun, { freshImage }: { freshImage: boolean }) {
  await run.report.scenario("Photos: own library, formats, ranges, identity, long timeline", () =>
    ownLibrary(run, freshImage),
  );
  await run.report.scenario("Photos: a shared folder stays out of the library", () =>
    sharedFolderStaysOutOfLibrary(run),
  );
}

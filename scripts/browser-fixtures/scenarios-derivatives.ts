import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { accountPassword, addUser, openUsers } from "./scenarios-admin.ts";
import { rowMenu, signIn, uploadFiles } from "./page-actions.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import {
  closeViewer,
  createFolder,
  openPhotos,
  stageState,
  tile,
  tileSelector,
  waitForTrayIdle,
} from "./scenarios-photos.ts";
import { captionCollisions } from "./scenarios-thumbnails.ts";
import { audit, PHONE } from "./scenarios-touch.ts";

const MIB = 1024 * 1024;
const OVER_WORKER_INPUT_LIMIT = 65 * MIB;

// Generous: the backend claims one job per 5 second pass, and retries an outage after 20s, then 40s.
const JOB_TIMEOUT_MS = 240_000;

export const BACKLOG_SUMMARY = /^Preparing (a thumbnail|thumbnails) for \d+ of \d+ loaded items?$/;

const PHOTO = "bigphoto.png";
const CLIP = "clip.mp4";
const MALFORMED = "malformed.png";
const OVERSIZED = "huge.png";

function retryButton(page: Page, name: string) {
  return page.getByRole("button", { name: `Retry thumbnail of ${name}` });
}

/** What a tile shows right now, read from the page. */
function tileState(page: Page, name: string) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    const image = button?.querySelector("img");

    return {
      label: button?.getAttribute("aria-label") ?? null,
      src: image?.getAttribute("src") ?? null,
      complete: image?.complete ?? false,
      width: image?.naturalWidth ?? 0,
      height: image?.naturalHeight ?? 0,
      badge: button?.querySelector('[data-slot="media-tile-badge"]') != null,
    };
  }, tileSelector(name));
}

function waitForThumbnail(page: Page, name: string) {
  return page.waitForFunction(
    (selector) => {
      const image = document.querySelector(selector)?.querySelector("img");

      return image !== null && image !== undefined && image.complete && image.naturalWidth > 0;
    },
    tileSelector(name),
    { timeout: JOB_TIMEOUT_MS },
  );
}

function decodedVideoFrame(page: Page) {
  return page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>('[data-slot="lightbox"] video');

    if (video === null) throw new Error("No video in the viewer.");

    const state = () =>
      `readyState ${video.readyState}, currentTime ${video.currentTime}, seeking ${video.seeking}`;

    const seeked = new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true }),
    );

    // Ignore a queued old frame; this 24 fps fixture seeks to the frame at 2 seconds.
    let presented = false;

    const onFrame: VideoFrameRequestCallback = (_now, frame) => {
      if (Math.abs(frame.mediaTime - 2) <= 1 / 24) presented = true;
      else video.requestVideoFrameCallback(onFrame);
    };

    video.requestVideoFrameCallback(onFrame);
    video.currentTime = 2;

    // “seeked” can arrive before the decoder holds that frame, so wait for both, and say so on a
    // timeout instead of drawing whatever is there.
    const deadline = Date.now() + 8000;

    await Promise.race([seeked, new Promise((resolve) => setTimeout(resolve, 8000))]);

    while (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !presented) {
      if (Date.now() > deadline) throw new Error(`No decoded frame after seeking: ${state()}.`);

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const canvas = document.createElement("canvas");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");

    if (context === null) throw new Error("No canvas here.");

    context.drawImage(video, 0, 0);

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const colours = new Set<number>();

    for (let index = 0; index < data.length; index += 4 * 97) {
      colours.add(
        ((data[index] ?? 0) << 16) | ((data[index + 1] ?? 0) << 8) | (data[index + 2] ?? 0),
      );
    }

    return {
      width: canvas.width,
      height: canvas.height,
      distinctColours: colours.size,
      dataUrl: canvas.toDataURL("image/png"),
    };
  });
}

function statusOf(page: Page, url: string) {
  return page.evaluate(async (target) => (await fetch(target)).status, url);
}

function fixtureFiles({ media }: CoreRun) {
  return [
    media.png(PHOTO, 11, "1800x1350"),
    media.video(CLIP, 6, ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]),
    media.bytes(MALFORMED, 4096),
    media.bytes(OVERSIZED, OVER_WORKER_INPUT_LIMIT),
  ];
}

async function outageAndRetry(run: CoreRun, page: Page) {
  const { report, front, stack } = run;

  stack.stopWorker();
  await createFolder(page, "Pictures");

  const files = fixtureFiles(run);

  await uploadFiles(page, files);
  await waitForTrayIdle(run, page, files.length);
  await openPhotos(page, CLIP);
  front.resetCounters();
  await page.reload();
  await tile(page, CLIP).waitFor();

  await report.check("while the worker is away, tiles say they're being prepared", async () => {
    await page.getByRole("button", { name: `${CLIP}. Preparing thumbnail.` }).waitFor();
    await page.getByRole("button", { name: `${PHOTO}. Preparing thumbnail.` }).waitFor();
  });

  await report.check("waiting shows once, in the bar, scoped to what's loaded", async () => {
    await page.getByText(BACKLOG_SUMMARY).waitFor();
    assert.equal(await page.getByText("Preparing thumbnail", { exact: true }).count(), 0);
  });

  await report.check(
    "a source over the worker's limit says so at once, with no Retry",
    async () => {
      await page
        .getByRole("button", { name: `${OVERSIZED}. Too large for a thumbnail.` })
        .waitFor();
      assert.equal(await retryButton(page, OVERSIZED).count(), 0);
    },
  );

  await report.shot(page, "real-thumbnails-preparing");

  await report.check("a job that runs out of attempts gets a real failure and Retry", async () => {
    for (const name of [PHOTO, CLIP, MALFORMED]) {
      await retryButton(page, name).waitFor({ timeout: JOB_TIMEOUT_MS });
    }

    await page.getByRole("button", { name: `${CLIP}. Thumbnail unavailable.` }).waitFor();
    assert.equal(front.records.filter(({ operation }) => operation === "media.retry").length, 0);
  });

  await report.shot(page, "real-thumbnails-worker-outage");

  await report.check("no tile downloaded its original through any of that", () => {
    const originals = front.records.filter(({ path }) => path.startsWith("/api/storage/previews/"));

    assert.deepEqual(
      originals.map(({ path }) => path),
      [],
    );
    assert.equal(front.records.filter(({ operation }) => operation === "media.get").length, 0);
  });

  const phone = await freshContext(run, {
    ...PHONE,
    colorScheme: "dark",
    storageState: await page.context().storageState(),
  });

  const phonePage = await openPage(run, phone, "/photos");

  await retryButton(phonePage, CLIP).waitFor();
  await audit(run, phonePage, "Real failed thumbnails");
  await report.check(
    "on touch, real captions stay clear of Retry and inside the tile",
    async () => {
      assert.deepEqual(await captionCollisions(phonePage), []);
    },
  );
  await report.shot(phonePage, "real-thumbnails-outage-phone-dark");
  await phone.close();

  await report.check("Retry by keyboard asks once, and leaves focus on the tile", async () => {
    await tile(page, CLIP).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      `Retry thumbnail of ${CLIP}`,
    );
    await page.keyboard.press("Enter");
    await retryButton(page, CLIP).waitFor({ state: "detached", timeout: 30_000 });

    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

    assert.ok(focused?.startsWith(CLIP), `focus went to ${focused}`);

    const retries = front.records.filter(({ operation }) => operation === "media.retry");

    assert.deepEqual(
      retries.map(({ status }) => status),
      [200],
    );
  });

  await retryButton(page, PHOTO).click();
  await retryButton(page, MALFORMED).click();
  await stack.startWorker();
}

async function realResults(run: CoreRun, page: Page, files: { photo: number; clip: number }) {
  const { report, front } = run;

  await report.check("Retry after recovery reaches a real thumbnail", async () => {
    await waitForThumbnail(page, PHOTO);

    const photo = await tileState(page, PHOTO);

    assert.match(String(photo.src), /^\/api\/storage\/derivatives\/.+[?&]revision=\d+/);
    assert.ok(photo.width <= 384 && photo.height <= 384, `${photo.width}x${photo.height}`);
    assert.equal(photo.badge, false);
    report.observe("real thumbnail, as decoded", photo);
  });

  await report.check("a video gets a real poster, marked as a video", async () => {
    await waitForThumbnail(page, CLIP);

    const clip = await tileState(page, CLIP);

    assert.match(String(clip.src), /^\/api\/storage\/derivatives\//);
    assert.ok(clip.width <= 384 && clip.height <= 384, `${clip.width}x${clip.height}`);
    assert.equal(clip.badge, true);
    assert.equal(clip.label, `${CLIP}. Video.`);
    report.observe("real poster, as decoded", clip);
  });

  await report.check("bytes that aren't an image end as a reason, not a Retry", async () => {
    await page
      .getByRole("button", { name: `${MALFORMED}. Couldn’t read this file.` })
      .waitFor({ timeout: JOB_TIMEOUT_MS });
    assert.equal(await retryButton(page, MALFORMED).count(), 0);
  });

  await report.shot(page, "real-thumbnails-ready");

  const photo = await tileState(page, PHOTO);
  const clip = await tileState(page, CLIP);
  const thumbnailUrl = String(photo.src);

  await report.check(
    "a thumbnail is a small WebP, revalidated, through the real host",
    async () => {
      const reply = await page.evaluate(async (target) => {
        const read = async (range: string | null) => {
          const response = await fetch(target, range === null ? {} : { headers: { Range: range } });
          const body = await response.arrayBuffer();

          return {
            status: response.status,
            bytes: body.byteLength,
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
          part: await read("bytes=0-99"),
          conditional: {
            status: conditional.status,
            bytes: (await conditional.arrayBuffer()).byteLength,
          },
        };
      }, thumbnailUrl);

      report.observe("thumbnail response", {
        ...reply,
        originalBytes: { photo: files.photo, clip: files.clip },
      });
      assert.equal(reply.whole.status, 200);
      assert.equal(reply.whole.contentType, "image/webp");
      assert.equal(reply.whole.cacheControl, "private, no-cache");
      assert.ok(reply.whole.etag);
      assert.equal(reply.conditional.status, 304);
      assert.equal(reply.conditional.bytes, 0);
      assert.equal(reply.whole.contentTypeOptions, "nosniff");
      assert.ok(reply.whole.bytes <= 256 * 1024, `${reply.whole.bytes} bytes`);
      assert.equal(reply.part.status, 206);
      assert.ok(
        front.trace.some(({ path, status }) => path === thumbnailUrl && status === 200),
        "the gateway, and so the host behind it, didn't serve this",
      );
    },
  );

  await report.check("opening a photo shows the original, not its thumbnail", async () => {
    await tile(page, PHOTO).click();

    // Closed even when a check fails, so the next check doesn't start under an open viewer.
    try {
      const stage = await stageState(page);

      assert.equal(stage.kind, "image");
      assert.ok(stage.kind === "image" && stage.naturalWidth === 1800, "not the original");
      assert.match(String(stage.src), /^\/api\/storage\/previews\//);
    } finally {
      await closeViewer(page);
    }
  });

  await report.check("opening a video plays the original stream, not its poster", async () => {
    await tile(page, CLIP).click();

    // Closed even when a check fails, so the next scenario doesn't start under an open viewer.
    try {
      const stage = await stageState(page);

      assert.equal(stage.kind, "video");
      assert.ok(stage.kind === "video" && stage.errorCode === 0, "didn't decode");
      assert.match(String(stage.src), /^\/api\/storage\/previews\//);

      // Headless screenshots can leave a playing video black, so ask the page for the decoded frame.
      const frame = await decodedVideoFrame(page);

      report.observe("decoded video frame, read back from the page", {
        width: frame.width,
        height: frame.height,
        distinctColours: frame.distinctColours,
      });
      writeFileSync(
        join(report.directory, "decoded-video-frame.png"),
        Buffer.from(frame.dataUrl.split(",")[1] ?? "", "base64"),
      );
      assert.ok(frame.distinctColours > 8, `${frame.distinctColours} colours: not a real picture`);
    } finally {
      await closeViewer(page);
    }
  });

  return { thumbnailUrl, posterUrl: String(clip.src) };
}

async function authorization(
  run: CoreRun,
  owner: Page,
  stranger: Page,
  thumbnailUrl: string,
  strangerEmail: string,
) {
  const { report } = run;

  await report.check("someone else can't read a thumbnail by its URL", async () => {
    const status = await statusOf(stranger, thumbnailUrl);

    assert.ok(status >= 400, `answered ${status}`);
  });

  await owner.getByRole("link", { name: "Files" }).first().click();
  await rowMenu(owner, "Pictures", "Share…");

  const dialog = owner.getByRole("dialog");

  await dialog.getByRole("combobox", { name: "Add people by name or email" }).fill(strangerEmail);
  // The suggestion popup renders through a portal, outside the dialog's DOM.
  await owner.getByRole("option", { name: new RegExp(strangerEmail) }).click();
  await dialog.getByRole("list", { name: "Who has access" }).waitFor();

  await report.check("sharing the folder lets them read it", async () => {
    assert.equal(await statusOf(stranger, thumbnailUrl), 200);
  });

  await dialog.getByRole("button", { name: "Remove" }).click();
  await dialog.getByRole("button", { name: "Remove" }).waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "Done" }).click();

  await report.check("ending the share ends that, for the URL they already have", async () => {
    const status = await statusOf(stranger, thumbnailUrl);

    assert.ok(status >= 400, `answered ${status}`);
  });
}

async function signedInAccount(run: CoreRun, name: string, email: string, password: string) {
  const context = await freshContext(run);
  const page = await openPage(run, context);

  await signIn(page, email, password);
  await page.getByText("No files yet").waitFor();
  await page.getByRole("button", { name: new RegExp(name) }).waitFor();

  return { context, page };
}

/**
 * The real worker, over its private socket, through the real host. Nothing is injected: the failure
 * is the worker really being down, and every state comes from the backend's own timeline.
 */
export async function runDerivativeScenarios(run: CoreRun) {
  const { report, media } = run;

  if (run.worker === null) {
    report.unverified("real thumbnails and posters", "needs --worker");

    return;
  }

  await report.scenario("Real thumbnails: outage, Retry, results, authorization", async () => {
    const admin = await ownerPage(run);
    const dana = { name: "Dana Okafor", email: "dana@example.test", password: accountPassword() };
    const omar = { name: "Omar Reyes", email: "omar@example.test", password: accountPassword() };

    await openUsers(admin.page);
    await addUser(admin.page, dana.name, dana.email, dana.password);
    await addUser(admin.page, omar.name, omar.email, omar.password);
    await admin.context.close();

    const owner = await signedInAccount(run, dana.name, dana.email, dana.password);
    const stranger = await signedInAccount(run, omar.name, omar.email, omar.password);

    await outageAndRetry(run, owner.page);

    const { thumbnailUrl } = await realResults(run, owner.page, {
      photo: statSync(`${media.directory}/${PHOTO}`).size,
      clip: statSync(`${media.directory}/${CLIP}`).size,
    });

    await authorization(run, owner.page, stranger.page, thumbnailUrl, omar.email);
    await stranger.context.close();
    await owner.context.close();
  });
}

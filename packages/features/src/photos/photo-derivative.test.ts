import { describe, expect, test } from "bun:test";
import type { MediaDerivative } from "#features/photos/photo-derivative.ts";
import {
  photoTileCaption,
  photoTileStatus,
  thumbnailProgressSummary,
  TIMELINE_REFRESH_MS,
  timelineRefreshDelay,
} from "#features/photos/photo-derivative.ts";

const identity = { kind: "thumbnail", sourceRevision: 1 } as const;

function pageOf(...derivatives: readonly (MediaDerivative | undefined)[]) {
  return { items: derivatives.map((derivative) => ({ derivative })) };
}

const READY: MediaDerivative = { ...identity, status: "ready", url: "/d", width: 1, height: 1 };
const QUEUED: MediaDerivative = { ...identity, status: "queued" };
const PROCESSING: MediaDerivative = { ...identity, status: "processing" };
const UNAVAILABLE: MediaDerivative = { ...identity, status: "unavailable" };

const FAILED: MediaDerivative = {
  ...identity,
  status: "failed",
  failure: "busy",
  canRetry: true,
};

const UNSUPPORTED: MediaDerivative = { ...identity, status: "unsupported", failure: "unsupported" };

describe("how often the timeline looks for finished thumbnails", () => {
  test("it looks while something on screen is on its way", () => {
    expect(timelineRefreshDelay([pageOf(READY, QUEUED)])).toBe(TIMELINE_REFRESH_MS);
    expect(timelineRefreshDelay([pageOf(READY), pageOf(PROCESSING)])).toBe(TIMELINE_REFRESH_MS);
  });

  test("it stops once nothing will change by itself", () => {
    expect(timelineRefreshDelay([pageOf(READY, FAILED, UNSUPPORTED)])).toBe(false);
  });

  test("a server with no worker reports unavailable, which never changes by waiting", () => {
    expect(timelineRefreshDelay([pageOf(UNAVAILABLE, UNAVAILABLE)])).toBe(false);
  });

  test("a server that sends no state is never polled", () => {
    expect(timelineRefreshDelay([pageOf(undefined, undefined)])).toBe(false);
  });

  test("refreshing reloads every loaded page, so a long scrollback doesn't poll", () => {
    const pages = Array.from({ length: 4 }, () => pageOf(QUEUED));

    expect(timelineRefreshDelay(pages.slice(0, 3))).toBe(TIMELINE_REFRESH_MS);
    expect(timelineRefreshDelay(pages)).toBe(false);
  });
});

describe("what a tile says about its thumbnail", () => {
  test("waiting states read the same, because the difference isn't actionable", () => {
    expect(photoTileStatus(QUEUED)).toBe("Preparing thumbnail");
    expect(photoTileStatus(PROCESSING)).toBe("Preparing thumbnail");
  });

  test("waiting stays out of the tile's visible words, but a failure stays on it", () => {
    expect(photoTileCaption(QUEUED)).toBeNull();
    expect(photoTileCaption(PROCESSING)).toBeNull();
    expect(photoTileCaption(FAILED)).toBe(photoTileStatus(FAILED));
    expect(photoTileCaption(FAILED)).not.toBeNull();
    expect(photoTileCaption(UNSUPPORTED)).toBe(photoTileStatus(UNSUPPORTED));
  });

  test("states with a picture or nothing to explain say nothing", () => {
    expect(photoTileCaption(undefined)).toBeNull();
    expect(photoTileCaption(READY)).toBeNull();
    expect(photoTileCaption(UNAVAILABLE)).toBeNull();
  });

  test("each failure names its own reason", () => {
    const reasons = (
      ["unavailable", "invalidMedia", "resourceLimit", "unsupported", "timeout", "busy"] as const
    ).map((failure) =>
      photoTileCaption({ ...identity, status: "failed", failure, canRetry: true }),
    );

    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons.every((reason) => reason !== null && !/[–—]/.test(reason))).toBe(true);
  });
});

describe("the summary of thumbnails on their way", () => {
  test("says how many of the loaded items, across every loaded page", () => {
    expect(thumbnailProgressSummary([pageOf(QUEUED, READY), pageOf(PROCESSING, FAILED)])).toBe(
      "Preparing thumbnails for 2 of 4 loaded items",
    );
  });

  test("always scopes itself to what's loaded, so it can't read as the whole library", () => {
    const manyPages = Array.from({ length: 5 }, () => pageOf(QUEUED, QUEUED));

    expect(thumbnailProgressSummary(manyPages)).toContain("loaded");
    expect(thumbnailProgressSummary(manyPages)).toContain("10 of 10");
  });

  test("reads properly for one", () => {
    expect(thumbnailProgressSummary([pageOf(QUEUED)])).toBe(
      "Preparing a thumbnail for 1 of 1 loaded item",
    );
    expect(thumbnailProgressSummary([pageOf(QUEUED, READY)])).toBe(
      "Preparing a thumbnail for 1 of 2 loaded items",
    );
  });

  test("counts only what's really on its way", () => {
    expect(thumbnailProgressSummary([pageOf(READY, FAILED, UNSUPPORTED, UNAVAILABLE)])).toBeNull();
  });

  test("a server that sends no state has nothing to summarize", () => {
    expect(thumbnailProgressSummary([pageOf(undefined, undefined)])).toBeNull();
  });

  test("nothing loaded yet has nothing to summarize", () => {
    expect(thumbnailProgressSummary([])).toBeNull();
  });
});

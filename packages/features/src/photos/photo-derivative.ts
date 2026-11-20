import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";

export type PhotoItem = OutputOf<RPC["photos"]["timeline"]>["items"][number];

export type LibraryItem = OutputOf<RPC["photos"]["library"]>["items"][number];

export type PhotoCapture = OutputOf<RPC["photos"]["details"]>["capture"];

export type PhotoCamera = NonNullable<OutputOf<RPC["photos"]["details"]>["camera"]>;

export type OriginalDimensions = NonNullable<
  OutputOf<RPC["photos"]["details"]>["originalDimensions"]
>;

export type MediaDerivative = NonNullable<PhotoItem["derivative"]>;

export type PhotoDisplayPreview = NonNullable<PhotoItem["displayPreview"]>;

type DerivativeFailure = Extract<MediaDerivative, { status: "failed" }>["failure"];

// Keyed by the contract's union, so a new failure fails typechecking here until it has copy.
const FAILURE_CAPTION: Record<DerivativeFailure, string> = {
  unavailable: "Thumbnail unavailable",
  invalidMedia: "Couldn’t read this file",
  resourceLimit: "Too large for a thumbnail",
  unsupported: "No thumbnail for this format",
  timeout: "Thumbnail took too long",
  busy: "Server was busy",
};

function isPreparing(preview: MediaDerivative | PhotoDisplayPreview | undefined) {
  return preview?.status === "queued" || preview?.status === "processing";
}

/** What a tile's label says about its thumbnail. Nothing here limits viewing the original. */
export function photoTileStatus(derivative: MediaDerivative | undefined): string | null {
  if (derivative === undefined) return null;

  switch (derivative.status) {
    case "queued":
    case "processing":
      return "Preparing thumbnail";
    case "unsupported":
    case "failed":
      return FAILURE_CAPTION[derivative.failure];
    case "ready":
    case "unavailable":
      return null;
    default:
      derivative satisfies never;

      return null;
  }
}

/**
 * What a tile shows in words. Waiting is the common case and looks the same on every tile, so it
 * stays in the label and the bar's summary. A failure is the exception, so it stays on its tile.
 */
export function photoTileCaption(derivative: MediaDerivative | undefined): string | null {
  return isPreparing(derivative) ? null : photoTileStatus(derivative);
}

export const TIMELINE_REFRESH_MS = 15_000;

const MAX_REFRESHED_PAGES = 3;

type DerivativePage = {
  readonly items: readonly {
    readonly derivative?: MediaDerivative | undefined;
    readonly displayPreview?: PhotoDisplayPreview | undefined;
  }[];
};

/**
 * Only queued and processing change by waiting, and the server caps their attempts, so this ends.
 * A photo's full-size rendition is its own job, so a ready thumbnail can't end the wait while the
 * display is still coming. A refresh rereads every loaded page, so a long scrollback waits for its
 * next natural refetch.
 */
export function timelineRefreshDelay(pages: readonly DerivativePage[]): number | false {
  if (pages.length > MAX_REFRESHED_PAGES) return false;

  const preparing = pages.some((page) =>
    page.items.some(
      ({ derivative, displayPreview }) => isPreparing(derivative) || isPreparing(displayPreview),
    ),
  );

  return preparing ? TIMELINE_REFRESH_MS : false;
}

/**
 * Only ever about loaded pages, and says so: the server reports no total, so this can't stand for
 * everything waiting in the library. It's derived from the timeline read, with no state of its own.
 */
export function thumbnailProgressSummary(pages: readonly DerivativePage[]): string | null {
  const items = pages.flatMap((page) => page.items);
  const preparing = items.filter(({ derivative }) => isPreparing(derivative)).length;

  if (preparing === 0) return null;

  const noun = items.length === 1 ? "item" : "items";
  const subject = preparing === 1 ? "a thumbnail" : "thumbnails";

  return `Preparing ${subject} for ${preparing} of ${items.length} loaded ${noun}`;
}

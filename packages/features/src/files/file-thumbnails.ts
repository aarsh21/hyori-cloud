import type { FileList } from "@hyori-cloud/client-sdk";

/** A refresh rereads whole pages, never individual rows, and stops after a long scrollback. */
export function fileThumbnailsRefreshDelay(pages: readonly FileList[]): number | false {
  if (pages.length > 3) return false;

  return pages.some((page) => Object.values(page.thumbnails ?? {}).some(({ pending }) => pending))
    ? 15_000
    : false;
}

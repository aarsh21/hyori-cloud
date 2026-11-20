import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation, useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";
import { timelineRefreshDelay } from "#features/photos/photo-derivative.ts";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";

/** Everyone's whole library: media the server discovered that this account owns. */
export function usePhotoLibrary() {
  const { query, rpc } = useClientSDK();

  return useCursorPages(
    query.photos.library,
    rpc.photos.library,
    {},
    undefined,
    timelineRefreshDelay,
  );
}

export type PhotoLibrary = ReturnType<typeof usePhotoLibrary>;

/** One album's own ordering, kept separate from the library feed's contract. */
export function usePhotoTimeline(albumId?: string) {
  const { query, rpc } = useClientSDK();

  return useCursorPages(
    query.photos.timeline,
    rpc.photos.timeline,
    albumId === undefined ? {} : { albumId },
    undefined,
    timelineRefreshDelay,
  );
}

export type PhotoTimeline = ReturnType<typeof usePhotoTimeline>;

export function useRetryThumbnail() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.media.retry.mutationOptions());
}

export function useAlbums(): Refreshable<ResourceOf<Query["photos"]["albums"]>> {
  const { query } = useClientSDK();

  return useQuery(query.photos.albums.getOptions({}));
}

export function useCreateAlbum() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.photos.createAlbum.mutationOptions());
}

export function useAddToAlbum() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.photos.addToAlbum.mutationOptions());
}

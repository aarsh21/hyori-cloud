import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQueryClient } from "@hyori-cloud/lib/query";
import { NO_FILTERS, toListFilesInput } from "#features/files/file-filters.ts";
import { readSort } from "#features/files/react/file-sort.ts";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { cursorPagesOptions } from "#features/shared/react/use-cursor-pages.ts";

/**
 * The first page a section's screen would ask for, fetched on hover or focus of its navigation
 * link, so the visit lands on data that is already here. Each input mirrors the screen's own
 * initial one exactly — the same query key, the same operation — and TanStack Query deduplicates,
 * so an already-fresh section prefetches nothing and a prefetch in flight is shared, not doubled.
 * Everything is best effort: a failed prefetch leaves a stale-marked query that the screen's own
 * mount refetches.
 */
export function useCloudDataPrefetch() {
  const { query, rpc } = useClientSDK();
  const queryClient = useQueryClient();

  return function prefetchCloudData(location: CloudLocation) {
    switch (location.section) {
      case "files":
        if (location.folderId === null) {
          void queryClient.prefetchInfiniteQuery(
            cursorPagesOptions(query.files.list, rpc.files.list, {
              ...toListFilesInput(null, "files", NO_FILTERS),
              sort: readSort(),
            }),
          );
        }

        break;
      case "shared":
        void queryClient.prefetchInfiniteQuery(
          cursorPagesOptions(query.files.list, rpc.files.list, {
            ...toListFilesInput(null, "shared", NO_FILTERS),
            sort: readSort(),
          }),
        );
        break;
      case "trash":
        void queryClient.prefetchInfiniteQuery(
          cursorPagesOptions(query.files.list, rpc.files.list, { view: "trash" }),
        );
        break;
      case "photos":
        void queryClient.prefetchInfiniteQuery(
          cursorPagesOptions(query.photos.library, rpc.photos.library, {}),
        );
        break;
      case "notes":
        void queryClient.prefetchQuery(
          query.notes.list.getOptions({
            search: "",
            favorites: false,
            trash: false,
            cursor: undefined,
          }),
        );
        break;
      case "admin":
        void queryClient.prefetchInfiniteQuery(
          cursorPagesOptions(query.admin.users, rpc.admin.users, {}),
        );
        break;
      case "editor":
      case "album":
      case "albums":
      case "invite":
      case "passwordReset":
      case "publicShare":
      case "publicEditor":
      case "notFound":
        // Single-item screens and public routes open one thing, not a first page.
        break;
      default:
        location satisfies never;
    }
  };
}

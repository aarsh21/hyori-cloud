import { useState } from "@hyori-cloud/lib/react";
import type { FileView } from "#features/files/file-filters.ts";
import { useFileListing } from "#features/files/react/use-file-listing.ts";

/** Drill-in state for folder pickers. Only folders are requested, filtered on the server. */
export function useFolderBrowser(initialFolderId: string | null = null, rootView?: FileView) {
  const [folderId, setFolderId] = useState(initialFolderId);

  const listing = useFileListing({
    parentId: folderId,
    type: "folder",
    view: folderId === null ? rootView : undefined,
  });

  const breadcrumbs = listing.data?.pages[0]?.breadcrumbs ?? [];

  return {
    folderId,
    open: setFolderId,
    listing,
    breadcrumbs,
    parentOf: breadcrumbs.at(-2)?.id ?? null,
    folders: listing.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

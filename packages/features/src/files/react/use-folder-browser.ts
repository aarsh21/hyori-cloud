import { useState } from "@hyori-cloud/lib/react";
import { useFileListing } from "#features/files/react/use-file-listing.ts";

/** Drill-in state for folder pickers. Only folders are requested, filtered on the server. */
export function useFolderBrowser(initialFolderId: string | null = null) {
  const [folderId, setFolderId] = useState(initialFolderId);
  const listing = useFileListing({ parentId: folderId, type: "folder" });
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

import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import type { ListFilesInput } from "#features/files/file-filters.ts";
import { fileThumbnailsRefreshDelay } from "#features/files/file-thumbnails.ts";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";

export function useFileListing(input: ListFilesInput, retainScope?: string) {
  const { query, rpc } = useClientSDK();

  return useCursorPages(
    query.files.list,
    rpc.files.list,
    input,
    retainScope,
    fileThumbnailsRefreshDelay,
  );
}

export type FileListing = ReturnType<typeof useFileListing>;

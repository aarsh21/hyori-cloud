import type { InputOf, OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";
import { startBrowserDownload } from "@hyori-cloud/ui/lib/browser";
import type { CloudError } from "#features/shared/cloud-error.ts";
import type { FileActionScope } from "#features/files/react/file-action-scope.ts";

type Download = RPC["files"]["download"];

export const DOWNLOAD_MUTATION_KEY = ["files", "download", "browser"];

/** Requests the capability on click, then lets the browser's download manager stream to disk. */
export function useDownloadFile(scope?: FileActionScope) {
  const { rpc } = useClientSDK();

  return useMutation<OutputOf<Download>, CloudError, InputOf<Download>>({
    mutationKey: DOWNLOAD_MUTATION_KEY,
    meta: scope,
    mutationFn: (input) => rpc.files.download(input),
    onSuccess: ({ url }) => startBrowserDownload(url),
    // Only the read-only descriptor is retried. Once bytes start, the browser owns the download.
    retry: (failures, error) => failures === 0 && error.code === "SDK_TRANSPORT",
  });
}

type DownloadFolder = RPC["files"]["downloadFolder"];

/**
 * A folder downloads as a ZIP the server streams. A folder over the archive limits is refused when
 * that stream opens, before any bytes, and the browser's download manager would only report a
 * failed download. So the stream is opened here first and dropped at once; the browser then fetches
 * the same address and streams the ZIP to disk itself, with its own progress.
 */
export function useDownloadFolder(scope?: FileActionScope) {
  const { downloads } = useClientSDK();

  return useMutation<OutputOf<DownloadFolder>, CloudError, InputOf<DownloadFolder>>({
    mutationKey: DOWNLOAD_MUTATION_KEY,
    meta: scope,
    mutationFn: async (input) => {
      const opened = await downloads.openFolder(input);

      await opened.stream.cancel().catch(() => undefined);

      return opened.metadata;
    },
    onSuccess: ({ url }) => startBrowserDownload(url),
    retry: (failures, error) => failures === 0 && error.code === "SDK_TRANSPORT",
  });
}

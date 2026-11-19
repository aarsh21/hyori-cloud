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
    onSuccess: ({ url, name }) => startBrowserDownload(url, name),
    // Only the read-only descriptor is retried. Once bytes start, the browser owns the download.
    retry: (failures, error) => failures === 0 && error.code === "SDK_TRANSPORT",
  });
}

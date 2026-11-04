import type { MutationOptions } from "@hyori-cloud/lib/query-core";
import type { Client } from "#client-sdk/client";
import type { ErrorOf, OutputOf } from "#client-sdk/inference";
import type { RPC } from "#client-sdk/product-types";
import type { StartUpload, UploadOptions, UploadTask } from "#client-sdk/features/uploads/upload";

/** Query owns submission state and the existing completion policy; vanilla SDK owns all bytes. */
export function uploadMutationOptions(
  sdkClient: Client,
  options?: UploadOptions & { readonly onTask?: (task: UploadTask) => void },
): MutationOptions<
  OutputOf<RPC["uploads"]["complete"]>,
  ErrorOf<RPC["uploads"]["complete"]>,
  StartUpload
> {
  return {
    mutationKey: sdkClient.mutation.uploads.complete.key,
    retry: false,
    mutationFn: (input) => {
      const task = sdkClient.uploads.start(input, options);

      try {
        options?.onTask?.(task);
      } catch {
        /* Observers do not own transfer completion. */
      }

      return task.result;
    },
  };
}

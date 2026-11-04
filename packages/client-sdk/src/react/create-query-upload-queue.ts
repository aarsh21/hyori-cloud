import type { QueryClient } from "@hyori-cloud/lib/query-core";
import type { Client } from "#client-sdk/client";
import { createUploadQueue } from "#client-sdk/features/uploads/upload-queue";
import type { CheckpointStore } from "#client-sdk/features/uploads/upload-queue";
import { reconcileMutation } from "#client-sdk/mutation-defaults";

/** The same declaration policy applies after first-attempt, retried and resumed task completions. */
export function createQueryUploadQueue(
  sdkClient: Client,
  queryClient: QueryClient,
  store: CheckpointStore,
) {
  return createUploadQueue(sdkClient, store, {
    onStored: () => reconcileMutation(queryClient, sdkClient.mutation.uploads.complete.key),
  });
}

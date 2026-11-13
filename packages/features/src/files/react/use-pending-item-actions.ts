import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutationState, useQueryClient } from "@hyori-cloud/lib/query";
import type { QueryKey } from "@hyori-cloud/lib/query";
import { DOWNLOAD_MUTATION_KEY } from "#features/files/react/use-download-file.ts";
import { isItemTarget } from "#features/files/react/file-action-scope.ts";

function usePendingIds(mutationKey: QueryKey | undefined) {
  return useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) => mutation.state.variables,
  })
    .filter(isItemTarget)
    .map((target) => target.id);
}

/**
 * The mutation cache already knows what's in flight, across every observer. It also updates during
 * `mutate`, so a second click in the same frame, before any rerender, is still recognized.
 */
export function usePendingItemActions() {
  const { mutation } = useClientSDK();
  const queryClient = useQueryClient();
  const trashKey = mutation.files.trash.mutationOptions().mutationKey;
  const downloading = usePendingIds(DOWNLOAD_MUTATION_KEY);
  const trashing = usePendingIds(trashKey);

  function isInFlight(mutationKey: QueryKey | undefined, id: string) {
    return queryClient
      .getMutationCache()
      .findAll({ mutationKey, status: "pending" })
      .some(({ state }) => isItemTarget(state.variables) && state.variables.id === id);
  }

  return {
    pendingIds: new Set([...downloading, ...trashing]),
    isDownloading: (id: string) => isInFlight(DOWNLOAD_MUTATION_KEY, id),
    isTrashing: (id: string) => isInFlight(trashKey, id),
  };
}

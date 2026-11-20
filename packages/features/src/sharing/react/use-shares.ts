import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { keepPreviousData, useMutation, useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";

export function useItemShares(
  itemId: string,
  enabled: boolean,
): Refreshable<ResourceOf<Query["shares"]["list"]>> {
  const { query } = useClientSDK();

  return useQuery({ ...query.shares.list.getOptions({ itemId }), enabled });
}

/** Directory search behind the sharing picker. The server matches; this only fetches. */
export function useUserSearch(
  query: string,
  enabled: boolean,
): Refreshable<ResourceOf<Query["users"]["search"]>> {
  const { query: operations } = useClientSDK();

  return useQuery({
    ...operations.users.search.getOptions({ query }),
    enabled,
    // A new query string is a new key; the previous answer stays up while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useCreateShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.create.mutationOptions());
}

export function useUpdateShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.update.mutationOptions());
}

export function useRevokeShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.revoke.mutationOptions());
}

export function useResolveShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.resolve.mutationOptions());
}

export function useUnlockShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.unlock.mutationOptions());
}

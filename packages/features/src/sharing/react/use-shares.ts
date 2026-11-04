import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation, useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";

export function useItemShares(
  itemId: string,
  enabled: boolean,
): Refreshable<ResourceOf<Query["shares"]["list"]>> {
  const { query } = useClientSDK();

  return useQuery({ ...query.shares.list.getOptions({ itemId }), enabled });
}

export function useCreateShare() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.shares.create.mutationOptions());
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

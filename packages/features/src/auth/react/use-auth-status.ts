import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";

export function useAuthStatus(): Refreshable<ResourceOf<Query["auth"]["status"]>> {
  const { query } = useClientSDK();

  return useQuery(query.auth.status.getOptions({}));
}

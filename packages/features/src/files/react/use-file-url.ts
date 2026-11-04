import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";

const URL_STALE_MS = 5 * 60_000;

/** Content URL for one file. Stays idle until `enabled`, so previews load only when actually shown. */
export function useFileUrl(
  id: string,
  enabled: boolean,
): Refreshable<ResourceOf<Query["files"]["download"]>> {
  const { query } = useClientSDK();

  return useQuery({
    ...query.files.download.getOptions({ id }),
    enabled,
    staleTime: URL_STALE_MS,
  });
}

import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";
import type { Refreshable } from "#features/shared/react/refreshable.ts";

/**
 * Inline URL for showing one file, separate from downloading it. Stays idle until `enabled`, so a
 * preview loads only when actually shown. The URL is stable and re-authorized on every read, so it
 * follows the ordinary freshness rules and a reopened viewer finds out if access has ended.
 */
export function useFileUrl(
  id: string,
  enabled: boolean,
): Refreshable<ResourceOf<Query["files"]["preview"]>> {
  const { query } = useClientSDK();

  return useQuery({ ...query.files.preview.getOptions({ id }), enabled });
}

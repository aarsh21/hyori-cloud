import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";

/** One instance-wide read shared through the app's cache, however many rows ask. */
export function useAvailableEditors() {
  const { query } = useClientSDK();

  return useQuery(query.editors.available.getOptions({}));
}

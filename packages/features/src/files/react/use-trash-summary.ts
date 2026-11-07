import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";

/** What emptying Trash removes and frees. Idle until a confirmation needs it. */
export function useTrashSummary(enabled: boolean) {
  const { query } = useClientSDK();

  return useQuery({ ...query.files.trashSummary.getOptions({}), enabled });
}

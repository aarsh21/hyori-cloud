import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";

/**
 * The file as it is now. `opened` is what the caller already received for it, so there's nothing to
 * wait for at first, and any mutation declared to change files refreshes this without being told.
 */
export function useCurrentFile(opened: FileEntry) {
  const { query } = useClientSDK();

  return useQuery({ ...query.files.get.getOptions({ id: opened.id }), initialData: opened });
}

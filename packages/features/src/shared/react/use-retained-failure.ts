import { useState } from "@hyori-cloud/lib/react";
import type { CloudError } from "#features/shared/cloud-error.ts";

/**
 * Query clears a query's error as soon as a retry starts if it has no data. Keeping the failure on
 * screen until there's an answer means the retry button stays put, and so does the focus on it.
 */
export function useRetainedFailure(error: CloudError | null, retrying: boolean) {
  const [latest, setLatest] = useState(error);

  if (error !== null && error !== latest) setLatest(error);

  return error ?? (retrying ? latest : null);
}

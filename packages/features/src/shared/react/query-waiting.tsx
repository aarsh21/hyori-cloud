import type { ReactNode } from "@hyori-cloud/lib/react";
import type { CloudError } from "#features/shared/cloud-error.ts";
import { OfflineState } from "#features/shared/react/offline-state.tsx";
import { QueryFailure } from "#features/shared/react/query-failure.tsx";
import { useRetainedFailure } from "#features/shared/react/use-retained-failure.ts";

/** A query with no data yet: failed, waiting for a connection, or simply on its way. */
export function QueryWaiting({
  resource,
  pending,
}: {
  resource: {
    readonly error: CloudError | null;
    readonly fetchStatus: "fetching" | "paused" | "idle";
    readonly refetch: () => void;
  };
  pending: ReactNode;
}) {
  const retrying = resource.fetchStatus === "fetching";
  const failure = useRetainedFailure(resource.error, retrying);

  if (failure !== null) {
    return <QueryFailure error={failure} retrying={retrying} onRetry={() => resource.refetch()} />;
  }

  if (resource.fetchStatus === "paused") return <OfflineState />;

  return pending;
}

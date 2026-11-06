import { CircleAlert } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Blocking failure for a region with no retained data. Recovery depends on what actually failed. */
export function QueryFailure({
  error,
  retrying = false,
  onRetry,
}: {
  error: CloudError;
  retrying?: boolean;
  onRetry: () => void;
}) {
  const recovery = useAccessRecovery(error);
  const copy = recovery ?? describeCloudError(error);

  return (
    <RegionState
      role="alert"
      icon={<CircleAlert />}
      title={copy.title}
      description={copy.detail}
      action={
        recovery === null ? (
          <Button
            variant="outline"
            pending={retrying}
            pendingLabel="Trying again…"
            onClick={() => onRetry()}
          >
            Try again
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} />
        )
      }
    />
  );
}

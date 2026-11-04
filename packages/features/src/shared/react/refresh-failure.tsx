import { Button } from "@hyori-cloud/ui/components/button";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Shown beside retained data when a background refresh fails; the content below stays usable. */
export function RefreshFailure({ error, onRetry }: { error: CloudError; onRetry: () => void }) {
  const recovery = useAccessRecovery(error);
  const copy = recovery ?? describeCloudError(error);

  return (
    <Notice
      title={`This may be out of date. ${copy.title}.`}
      action={
        recovery === null ? (
          <Button size="sm" variant="outline" onClick={() => onRetry()}>
            Refresh
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} size="sm" />
        )
      }
    />
  );
}

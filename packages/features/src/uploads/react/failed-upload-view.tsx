import type { UploadIntent } from "@hyori-cloud/client-sdk";
import { RotateCcw } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import { AccessRecoveryButton } from "#features/shared/react/access-recovery.tsx";
import type { AccessRecovery } from "#features/shared/react/access-recovery.tsx";
import {
  describeCancelFailure,
  describeUploadFailure,
} from "#features/uploads/upload-failure-copy.ts";

/**
 * A plain function rather than a component: its buttons have to stay part of the row's own tree, so
 * that pressing Retry doesn't remount the control holding keyboard focus.
 */
export function failedUploadView({
  intent,
  error,
  failedAction,
  recovery,
  cancel,
  retry,
  retryQueued,
}: {
  intent: UploadIntent;
  error: CloudError;
  /** What retrying continues. Retrying a failed cancel cancels; it never resumes the transfer. */
  failedAction: "upload" | "cancel" | undefined;
  recovery: AccessRecovery | null;
  cancel: ReactNode;
  retry: () => void;
  /** Retry was pressed and is waiting for a free slot. The queue owns this, not the row. */
  retryQueued: boolean;
}) {
  const copy = recovery ?? describeCloudError(error);
  const cancelFailed = failedAction === "cancel";

  const { detail, canRetry } = cancelFailed
    ? { detail: describeCancelFailure(error, copy), canRetry: false }
    : describeUploadFailure(intent, error, copy);

  // Retrying can't succeed once access is gone, so recovering it comes first and then resumes.
  if (recovery !== null && !retryQueued) {
    return {
      detail,
      actions: (
        <>
          <AccessRecoveryButton recovery={recovery} size="xs" onRecovered={retry} />
          {cancelFailed ? null : cancel}
        </>
      ),
    };
  }

  if (cancelFailed) {
    return {
      detail,
      actions: (
        <Button size="xs" variant="outline" pending={retryQueued} onClick={retry}>
          Try cancelling again
        </Button>
      ),
    };
  }

  return {
    detail,
    actions: (
      <>
        {canRetry ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Retry upload of ${intent.name}`}
            pending={retryQueued}
            onClick={retry}
          >
            <RotateCcw />
          </Button>
        ) : null}
        {cancel}
      </>
    ),
  };
}

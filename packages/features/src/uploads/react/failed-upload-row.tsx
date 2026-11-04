import { RotateCcw, X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { Progress } from "@hyori-cloud/ui/components/progress";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

/** Retrying can't succeed once access is gone, so recovering it comes first and then resumes. */
export function FailedUploadRow({
  id,
  name,
  percent,
  error,
  intent,
}: {
  id: string;
  name: string;
  percent: number;
  error: CloudError;
  /** What retrying continues. Retrying a failed cancel cancels; it never resumes the transfer. */
  intent: "upload" | "cancel" | undefined;
}) {
  const queue = useUploadQueue();
  const recovery = useAccessRecovery(error);
  const copy = recovery ?? describeCloudError(error);
  const cancelFailed = intent === "cancel";

  return (
    <TransferItem
      name={name}
      tone="destructive"
      detail={copy.detail ?? copy.title}
      progress={
        <Progress value={percent} tone="destructive" label={`Upload progress for ${name}`} />
      }
      actions={
        <>
          {recovery !== null ? (
            <AccessRecoveryButton
              recovery={recovery}
              size="xs"
              onRecovered={() => queue.retry(id)}
            />
          ) : null}
          {recovery === null && cancelFailed ? (
            <Button size="xs" variant="outline" onClick={() => queue.retry(id)}>
              Try cancelling again
            </Button>
          ) : null}
          {recovery === null && !cancelFailed ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Retry upload of ${name}`}
              onClick={() => queue.retry(id)}
            >
              <RotateCcw />
            </Button>
          ) : null}
          {cancelFailed ? null : (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Cancel upload of ${name}`}
              onClick={() => void queue.cancel(id).catch(() => undefined)}
            >
              <X />
            </Button>
          )}
        </>
      }
    />
  );
}

import type { UploadTask } from "@hyori-cloud/client-sdk";
import { useUpload } from "@hyori-cloud/client-sdk/react";
import { CheckCircle2, Pause, Play, X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { Progress } from "@hyori-cloud/ui/components/progress";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { formatBytes } from "#features/shared/format.ts";
import { useAccessRecoveryPolicy } from "#features/shared/react/access-recovery.tsx";
import { failedUploadView } from "#features/uploads/react/failed-upload-view.tsx";
import { NEW_VERSION_CANCELLED } from "#features/uploads/upload-failure-copy.ts";
import { UploadIntentTag } from "#features/uploads/react/upload-intent-tag.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

/**
 * Every state renders the same row with the same two action slots, so pressing Pause, Resume, or
 * Retry leaves keyboard focus on a control that's still there, in the same place.
 */
export function StartedUploadRow({
  id,
  task,
  retryQueued,
}: {
  id: string;
  task: UploadTask;
  retryQueued: boolean;
}) {
  const queue = useUploadQueue();
  const snapshot = useUpload(task);
  const { intent } = task;
  const { name } = intent;
  const accessRecovery = useAccessRecoveryPolicy();
  const label = `Upload progress for ${name}`;
  const tag = <UploadIntentTag intent={intent} />;

  const percent =
    snapshot.totalBytes === 0
      ? 0
      : // Rounded down, so nothing reads 100% while bytes are still on their way.
        Math.floor((snapshot.uploadedBytes / snapshot.totalBytes) * 100);

  const cancel = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Cancel upload of ${name}`}
      onClick={() => void queue.cancel(id).catch(() => undefined)}
    >
      <X />
    </Button>
  );

  // The server decides these from here, so a second request can't change the outcome.
  const committing = (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={`Pause upload of ${name}`} pending>
        <Pause />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={`Cancel upload of ${name}`} disabled>
        <X />
      </Button>
    </>
  );

  switch (snapshot.status) {
    case "pending":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail="Starting"
          progress={<Progress value={null} label={label} />}
          actions={
            <>
              <Button size="icon-sm" variant="ghost" aria-label={`Pause upload of ${name}`} pending>
                <Pause />
              </Button>
              {cancel}
            </>
          }
        />
      );
    case "uploading":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail={`${percent}% · ${formatBytes(snapshot.uploadedBytes)} of ${formatBytes(snapshot.totalBytes)}`}
          progress={<Progress value={percent} label={label} />}
          actions={
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Pause upload of ${name}`}
                onClick={() => queue.pause(id)}
              >
                <Pause />
              </Button>
              {cancel}
            </>
          }
        />
      );
    case "finalizing":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail="Finishing up"
          progress={<Progress value={null} label={label} />}
          actions={committing}
        />
      );
    case "cancelling":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail="Cancelling…"
          progress={<Progress value={null} label={label} />}
          actions={committing}
        />
      );
    case "paused":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail={retryQueued ? `Waiting to resume at ${percent}%` : `Paused at ${percent}%`}
          progress={<Progress value={percent} label={label} />}
          actions={
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Resume upload of ${name}`}
                pending={retryQueued}
                onClick={() => queue.retry(id)}
              >
                <Play />
              </Button>
              {cancel}
            </>
          }
        />
      );
    case "failed": {
      const { detail, actions } = failedUploadView({
        intent,
        error: snapshot.error,
        failedAction: snapshot.intent,
        recovery: accessRecovery(snapshot.error),
        cancel,
        retry: () => queue.retry(id),
        retryQueued,
      });

      // It's no longer failing, only waiting its turn, so it stops reading as a failure.
      if (retryQueued) {
        return (
          <TransferItem
            name={name}
            tag={tag}
            detail={snapshot.intent === "cancel" ? "Waiting to cancel" : "Waiting to retry"}
            progress={<Progress value={percent} label={label} />}
            actions={actions}
          />
        );
      }

      return (
        <TransferItem
          name={name}
          tag={tag}
          tone="destructive"
          detail={detail}
          progress={<Progress value={percent} tone="destructive" label={label} />}
          actions={actions}
        />
      );
    }

    case "cancelled":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail={intent.kind === "replacement" ? NEW_VERSION_CANCELLED : "Cancelled"}
          wrapDetail={intent.kind === "replacement"}
          actions={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={() => queue.dismiss(id)}
            >
              <X />
            </Button>
          }
        />
      );
    case "complete":
      return (
        <TransferItem
          name={name}
          tag={tag}
          detail={formatBytes(snapshot.totalBytes)}
          actions={<CheckCircle2 aria-label="Uploaded" className="mr-1.5 size-4 text-success" />}
        />
      );
  }

  snapshot satisfies never;

  return null;
}

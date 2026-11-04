import type { UploadTask } from "@hyori-cloud/client-sdk";
import { useUpload } from "@hyori-cloud/client-sdk/react";
import { CheckCircle2, RotateCcw, X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { Progress } from "@hyori-cloud/ui/components/progress";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { formatBytes } from "#features/shared/format.ts";
import { FailedUploadRow } from "#features/uploads/react/failed-upload-row.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

export function StartedUploadRow({
  id,
  name,
  task,
}: {
  id: string;
  name: string;
  task: UploadTask;
}) {
  const queue = useUploadQueue();
  const snapshot = useUpload(task);
  const label = `Upload progress for ${name}`;

  const percent =
    snapshot.totalBytes === 0
      ? 0
      : Math.round((snapshot.uploadedBytes / snapshot.totalBytes) * 100);

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
  const cancelUnavailable = (
    <Button size="icon-sm" variant="ghost" aria-label={`Cancel upload of ${name}`} disabled>
      <X />
    </Button>
  );

  const remove = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Remove ${name}`}
      onClick={() => queue.dismiss(id)}
    >
      <X />
    </Button>
  );

  switch (snapshot.status) {
    case "pending":
      return (
        <TransferItem
          name={name}
          detail="Starting"
          progress={<Progress value={null} label={label} />}
          actions={cancel}
        />
      );
    case "uploading":
      return (
        <TransferItem
          name={name}
          detail={`${percent}% · ${formatBytes(snapshot.uploadedBytes)} of ${formatBytes(snapshot.totalBytes)}`}
          progress={<Progress value={percent} label={label} />}
          actions={cancel}
        />
      );
    case "finalizing":
      return (
        <TransferItem
          name={name}
          detail="Finishing up"
          progress={<Progress value={null} label={label} />}
          actions={cancelUnavailable}
        />
      );
    case "cancelling":
      return (
        <TransferItem
          name={name}
          detail="Cancelling…"
          progress={<Progress value={null} label={label} />}
          actions={cancelUnavailable}
        />
      );
    case "paused":
      return (
        <TransferItem
          name={name}
          detail={`Paused at ${percent}%`}
          progress={<Progress value={percent} label={label} />}
          actions={
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Resume upload of ${name}`}
                onClick={() => queue.retry(id)}
              >
                <RotateCcw />
              </Button>
              {cancel}
            </>
          }
        />
      );
    case "failed":
      return (
        <FailedUploadRow
          id={id}
          name={name}
          percent={percent}
          error={snapshot.error}
          intent={snapshot.intent}
        />
      );
    case "cancelled":
      return <TransferItem name={name} detail="Cancelled" actions={remove} />;
    case "complete":
      return (
        <TransferItem
          name={name}
          detail={formatBytes(snapshot.totalBytes)}
          actions={<CheckCircle2 aria-label="Uploaded" className="mr-1.5 size-4 text-success" />}
        />
      );
  }

  snapshot satisfies never;

  return null;
}

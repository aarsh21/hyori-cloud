import type { UploadEntry, UploadQueue } from "@hyori-cloud/client-sdk";
import { useClientSDK, useUploadEntries } from "@hyori-cloud/client-sdk/react";
import { X } from "@hyori-cloud/lib/icons";
import { useMutation } from "@hyori-cloud/lib/query";
import { useRef } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { Stack, Text } from "@hyori-cloud/ui/components/text";
import { TransferItem, TransferList } from "@hyori-cloud/ui/components/transfer-tray";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { formatBytes, formatDateTime } from "#features/shared/format.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";
import { describeCancelFailure } from "#features/uploads/upload-failure-copy.ts";

type PendingUpload = Awaited<ReturnType<UploadQueue["listPending"]>>["items"][number];

/**
 * Every upload this account started and hasn't finished, in any browser. Each holds storage until it
 * finishes, is cancelled, or expires. Only this browser can resume one, and only after the person
 * chooses the same file again; elsewhere it can only be cancelled.
 */
export function PendingUploadsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unfinished uploads</DialogTitle>
          <DialogDescription>
            Uploads you started here or in another browser. Each holds storage until it finishes, is
            cancelled, or expires.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <PendingUploads />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function usePendingUploads() {
  const { query } = useClientSDK();
  const queue = useUploadQueue();

  return useCursorPages(
    query.uploads.pending,
    async (input, options) => {
      const page = await queue.listPending(input, options);

      return { ...page, nextCursor: page.cursor };
    },
    { cursor: null, limit: 100 },
  );
}

function PendingUploads() {
  const pages = usePendingUploads();
  const entries = useUploadEntries(useUploadQueue());
  const recovery = useAccessRecovery(pages.error);

  if (pages.data === undefined) {
    if (pages.error !== null) {
      const copy = recovery ?? describeCloudError(pages.error);

      return (
        <Notice
          title={copy.title}
          action={
            recovery === null ? (
              <Button size="sm" variant="outline" onClick={() => pages.refetch()}>
                Try again
              </Button>
            ) : (
              <AccessRecoveryButton recovery={recovery} size="sm" />
            )
          }
        >
          {copy.detail}
        </Notice>
      );
    }

    return (
      <Stack className="gap-3" aria-hidden>
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </Stack>
    );
  }

  const uploads = pages.data.pages.flatMap((page) => page.items);

  return (
    <>
      {pages.isRefetchError ? (
        <RefreshFailure error={pages.error} onRetry={() => pages.refetch()} />
      ) : null}
      {uploads.length === 0 ? (
        <Text tone="muted">
          Nothing unfinished. Every upload you started has finished or ended.
        </Text>
      ) : (
        <TransferList
          aria-label="Unfinished uploads"
          className="max-h-80 rounded-lg border border-t-border"
        >
          {uploads.map((upload) => (
            <PendingUploadRow
              key={upload.uploadId}
              upload={upload}
              entry={localEntry(entries, upload.uploadId)}
              onCancelled={() => pages.refetch()}
            />
          ))}
        </TransferList>
      )}
      <LoadMore pages={pages} />
    </>
  );
}

// This browser's own transfer of that upload, if it has one: resumed under its upload ID, or
// started here under a local ID whose checkpoint names it.
function localEntry(entries: readonly UploadEntry[], uploadId: string) {
  return entries.find(
    (entry) =>
      entry.id === uploadId ||
      (entry.state === "started" && entry.task.getSnapshot().checkpoint?.uploadId === uploadId),
  );
}

function PendingUploadRow({
  upload,
  entry,
  onCancelled,
}: {
  upload: PendingUpload;
  entry: UploadEntry | undefined;
  onCancelled: () => void;
}) {
  const size = formatBytes(upload.size);

  if (entry === undefined) return <RemoteUploadRow upload={upload} />;

  if (entry.state !== "interrupted") {
    return (
      <TransferItem name={upload.name} detail={`${size} · In this browser’s uploads`} wrapDetail />
    );
  }

  return <ResumableUploadRow upload={upload} entry={entry} onCancelled={onCancelled} />;
}

/** Started elsewhere, or its checkpoint is gone from this browser: cancelling is all that's left. */
function RemoteUploadRow({ upload }: { upload: PendingUpload }) {
  const { mutation } = useClientSDK();
  const abort = useMutation(mutation.uploads.abort.mutationOptions());

  const failure =
    abort.error === null
      ? null
      : describeCancelFailure(abort.error, describeCloudError(abort.error));

  return (
    <TransferItem
      name={upload.name}
      tone={failure === null ? "default" : "destructive"}
      wrapDetail
      detail={
        abort.isPending
          ? "Cancelling…"
          : (failure ??
            `${formatBytes(upload.size)} · Can only be cancelled here · Expires ${formatDateTime(upload.expiresAt)}`)
      }
      actions={
        <Button
          size="xs"
          variant="outline"
          pending={abort.isPending}
          pendingLabel="Cancelling…"
          aria-label={`Cancel upload of ${upload.name}`}
          onClick={() => abort.mutate({ uploadId: upload.uploadId })}
        >
          Cancel upload
        </Button>
      }
    />
  );
}

function ResumableUploadRow({
  upload,
  entry,
  onCancelled,
}: {
  upload: PendingUpload;
  entry: Extract<UploadEntry, { state: "interrupted" }>;
  onCancelled: () => void;
}) {
  const queue = useUploadQueue();
  const picker = useRef<FilePickerHandle>(null);
  const { error, cancelling = false } = entry;
  const localName = entry.checkpoint.file.name;

  function detail() {
    if (cancelling) return "Cancelling…";

    if (error === null) return `${formatBytes(upload.size)} · Choose “${localName}” to continue`;

    if (error.code === "SDK_FILE_MISMATCH") {
      return `That isn’t the same file. Choose “${localName}”, unchanged, to continue.`;
    }

    return describeCancelFailure(error, describeCloudError(error));
  }

  return (
    <TransferItem
      name={upload.name}
      tone={error === null ? "default" : "destructive"}
      wrapDetail
      detail={detail()}
      actions={
        <>
          <FilePicker
            ref={picker}
            multiple={false}
            onFiles={([file]) => file && queue.resume(entry.id, file)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={cancelling}
            onClick={() => picker.current?.open()}
          >
            Choose file
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Cancel upload of ${upload.name}`}
            disabled={cancelling}
            onClick={() => void queue.cancel(entry.id).then(onCancelled, () => undefined)}
          >
            <X />
          </Button>
        </>
      }
    />
  );
}

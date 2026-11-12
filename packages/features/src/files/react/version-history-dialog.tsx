import type { FileEntry, FileVersion } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { Download, Trash2 } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
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
import { PickerList, PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText, Stack } from "@hyori-cloud/ui/components/text";
import { DeleteVersionDialog } from "#features/files/react/delete-version-dialog.tsx";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useRestoreVersion } from "#features/files/react/use-file-mutations.ts";
import { formatBytes, formatDateTime } from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { PickerFailureRow } from "#features/shared/react/picker-failure-row.tsx";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";

function useFileVersions(id: string) {
  const { query, rpc } = useClientSDK();

  return useCursorPages(query.files.versions, rpc.files.versions, { id });
}

export function VersionHistoryDialog({
  entry,
  open,
  onOpenChange,
  onUploadNewVersion,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadNewVersion?: () => void;
}) {
  const versions = useFileVersions(entry.id);
  const restore = useRestoreVersion();
  const download = useDownloadFile();
  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];
  // Keeps its version while closing, after the row has already left the history.
  const [deleting, setDeleting] = useState<{ version: FileVersion; open: boolean } | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        restore.reset();
        download.reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Earlier contents of “{entry.name}”. Restoring keeps the current version in this list;
            deleting a version frees its storage.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-2">
          <PickerList aria-label="Versions">
            {/* Which contents are live, so each earlier version reads as a real comparison. */}
            <PickerRow className="justify-between gap-2 px-2 py-1 hover:bg-transparent">
              <Stack className="min-w-0">
                <InlineText truncate numeric>
                  {formatDateTime(entry.updatedAt)}
                </InlineText>
                <InlineText size="xs" tone="muted" numeric>
                  {formatBytes(entry.size)}
                </InlineText>
              </Stack>
              <Tag>Current</Tag>
            </PickerRow>
            {items.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                restoring={restore.isPending && restore.variables.versionId === version.id}
                restoreDisabled={restore.isPending}
                downloading={download.isPending && download.variables.versionId === version.id}
                onRestore={() =>
                  restore.mutate(
                    { id: entry.id, versionId: version.id },
                    {
                      onSuccess: () =>
                        toast(`Restored the version from ${formatDateTime(version.createdAt)}`),
                    },
                  )
                }
                onDownload={() => download.mutate({ id: entry.id, versionId: version.id })}
                onDelete={() => setDeleting({ version, open: true })}
              />
            ))}
            <VersionsState versions={versions} isEmpty={items.length === 0} />
          </PickerList>
          <MutationFailure error={restore.error ?? download.error} />
        </DialogBody>
        <DialogFooter>
          {entry.access.canEdit && onUploadNewVersion !== undefined ? (
            <Button
              type="button"
              variant="outline"
              className="sm:mr-auto"
              onClick={onUploadNewVersion}
            >
              Upload new version…
            </Button>
          ) : null}
          <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
      {deleting === null ? null : (
        <DeleteVersionDialog
          key={deleting.version.id}
          fileId={entry.id}
          version={deleting.version}
          open={deleting.open}
          onOpenChange={(next) => setDeleting({ ...deleting, open: next })}
        />
      )}
    </Dialog>
  );
}

function VersionRow({
  version,
  restoring,
  restoreDisabled,
  downloading,
  onRestore,
  onDownload,
  onDelete,
}: {
  version: FileVersion;
  restoring: boolean;
  restoreDisabled: boolean;
  downloading: boolean;
  onRestore: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const created = formatDateTime(version.createdAt);

  return (
    <PickerRow className="justify-between gap-2 px-2 py-1 hover:bg-transparent">
      <Stack className="min-w-0">
        <InlineText truncate numeric>
          {formatDateTime(version.createdAt)}
        </InlineText>
        <InlineText size="xs" tone="muted" numeric>
          {formatBytes(version.size)}
        </InlineText>
      </Stack>
      <Stack className="shrink-0 flex-row items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Download version from ${created}`}
          pending={downloading}
          onClick={onDownload}
        >
          {downloading ? (
            <Spinner label="Preparing download" className="text-current" />
          ) : (
            <Download />
          )}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete version from ${created}`}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={restoreDisabled && !restoring}
          pending={restoring}
          pendingLabel="Restoring…"
          onClick={onRestore}
        >
          Restore
        </Button>
      </Stack>
    </PickerRow>
  );
}

function VersionsState({
  versions,
  isEmpty,
}: {
  versions: ReturnType<typeof useFileVersions>;
  isEmpty: boolean;
}) {
  if (versions.data === undefined) {
    if (versions.error !== null) {
      return <PickerFailureRow error={versions.error} onRetry={() => versions.refetch()} />;
    }

    return (
      <PickerRow className="px-2 hover:bg-transparent">
        <Skeleton className="h-3 w-1/2" />
      </PickerRow>
    );
  }

  if (isEmpty) {
    return (
      <PickerRow className="px-2 hover:bg-transparent">
        <InlineText tone="muted">No earlier versions yet.</InlineText>
      </PickerRow>
    );
  }

  return <LoadMore pages={versions} />;
}

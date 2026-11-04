import type { FileEntry, FileVersion } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { Download } from "@hyori-cloud/lib/icons";
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
import { InlineText, Stack } from "@hyori-cloud/ui/components/text";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useRestoreVersion } from "#features/files/react/use-file-mutations.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { formatBytes, formatDateTime } from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";

function useFileVersions(id: string) {
  const { query, rpc } = useClientSDK();

  return useCursorPages(query.files.versions, rpc.files.versions, { id });
}

export function VersionHistoryDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const versions = useFileVersions(entry.id);
  const restore = useRestoreVersion();
  const download = useDownloadFile();
  const items = versions.data?.pages.flatMap((page) => page.items) ?? [];

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
            Earlier contents of “{entry.name}”. Restoring keeps the current version in this list.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-2">
          <PickerList aria-label="Versions">
            {items.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                restoring={restore.isPending && restore.variables.versionId === version.id}
                restoreDisabled={restore.isPending}
                onRestore={() => restore.mutate({ id: entry.id, versionId: version.id })}
                onDownload={() => download.mutate({ id: entry.id, versionId: version.id })}
              />
            ))}
            <VersionsState versions={versions} isEmpty={items.length === 0} />
          </PickerList>
          <MutationFailure error={restore.error ?? download.error} />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionRow({
  version,
  restoring,
  restoreDisabled,
  onRestore,
  onDownload,
}: {
  version: FileVersion;
  restoring: boolean;
  restoreDisabled: boolean;
  onRestore: () => void;
  onDownload: () => void;
}) {
  return (
    <PickerRow className="justify-between gap-2 px-2 py-1">
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
          aria-label={`Download version from ${formatDateTime(version.createdAt)}`}
          onClick={onDownload}
        >
          <Download />
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
      return (
        <PickerRow className="justify-between px-2 hover:bg-transparent">
          <InlineText tone="destructive" truncate>
            {describeCloudError(versions.error).title}
          </InlineText>
          <Button type="button" size="xs" variant="outline" onClick={() => versions.refetch()}>
            Try again
          </Button>
        </PickerRow>
      );
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

import type { FileEntry } from "@hyori-cloud/client-sdk";
import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { CreateFolderDialog } from "#features/files/react/create-folder-dialog.tsx";
import type { FileDialog, OpenFileDialog } from "#features/files/react/file-actions.tsx";
import {
  loadMoveDialog,
  loadReplaceFileDialog,
  loadShareDialog,
  loadVersionHistoryDialog,
} from "#features/files/react/file-dialog-loaders.ts";
import { RenameDialog } from "#features/files/react/rename-dialog.tsx";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { isMediaType } from "#features/shared/format.ts";

const MoveDialog = lazy(async () => ({ default: (await loadMoveDialog()).MoveDialog }));
const ShareDialog = lazy(async () => ({ default: (await loadShareDialog()).ShareDialog }));

const ReplaceFileDialog = lazy(async () => ({
  default: (await loadReplaceFileDialog()).ReplaceFileDialog,
}));

const VersionHistoryDialog = lazy(async () => ({
  default: (await loadVersionHistoryDialog()).VersionHistoryDialog,
}));

export function FileDialogs({
  active,
  entries,
  folderId,
  onSelect,
  onClose,
}: {
  active: OpenFileDialog | null;
  entries: readonly FileEntry[];
  folderId: string | null;
  onSelect: (dialog: FileDialog) => void;
  onClose: () => void;
}) {
  if (active === null) return null;
  const { dialog, open } = active;

  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  if (dialog.kind === "createFolder") {
    return <CreateFolderDialog parentId={folderId} open={open} onOpenChange={onOpenChange} />;
  }

  if (dialog.kind === "move") {
    return (
      <Suspense fallback={null}>
        <MoveDialog
          key={`${dialog.entry.id}:${dialog.entry.parentId}`}
          entry={dialog.entry}
          open={open}
          onOpenChange={onOpenChange}
        />
      </Suspense>
    );
  }

  const entry = entries.find((candidate) => candidate.id === dialog.id);

  if (entry === undefined) return null;

  switch (dialog.kind) {
    case "rename":
      return <RenameDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />;
    case "replace":
      return (
        <Suspense fallback={null}>
          <ReplaceFileDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />
        </Suspense>
      );
    case "share":
      return (
        <Suspense fallback={null}>
          <ShareDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />
        </Suspense>
      );
    case "versions":
      return (
        <Suspense fallback={null}>
          <VersionHistoryDialog
            key={entry.id}
            entry={entry}
            open={open}
            onOpenChange={onOpenChange}
            onUploadNewVersion={() => onSelect({ kind: "replace", id: entry.id })}
          />
        </Suspense>
      );
    case "viewer":
      return (
        <MediaViewer
          items={entries.filter((item) => item.kind === "file" && isMediaType(item.mimeType))}
          itemId={entry.id}
          open={open}
          onOpenChange={onOpenChange}
          onSelect={(id) => onSelect({ kind: "viewer", id })}
        />
      );
  }

  dialog satisfies never;

  return null;
}

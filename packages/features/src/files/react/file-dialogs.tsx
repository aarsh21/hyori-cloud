import type { FileEntry } from "@hyori-cloud/client-sdk";
import { DeferredDialog } from "@hyori-cloud/ui/components/deferred-dialog";
import type { FileDialog, OpenFileDialog } from "#features/files/react/file-actions.tsx";
import { CreateFolderDialog } from "#features/files/react/create-folder-dialog.tsx";
import { RenameDialog } from "#features/files/react/rename-dialog.tsx";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import {
  loadMoveDialog,
  loadReplaceFileDialog,
  loadShareDialog,
  loadVersionHistoryDialog,
} from "#features/files/react/file-dialog-loaders.ts";
import { isMediaType } from "#features/shared/format.ts";

const loadMove = async () => (await loadMoveDialog()).MoveDialog;
const loadShare = async () => (await loadShareDialog()).ShareDialog;
const loadReplace = async () => (await loadReplaceFileDialog()).ReplaceFileDialog;
const loadVersions = async () => (await loadVersionHistoryDialog()).VersionHistoryDialog;

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
      <DeferredDialog
        key={`${dialog.entry.id}:${dialog.entry.parentId}`}
        load={loadMove}
        title="Move"
        open={open}
        onClose={onClose}
        props={{ entry: dialog.entry, open, onOpenChange }}
      />
    );
  }

  const entry = entries.find((candidate) => candidate.id === dialog.id);

  if (entry === undefined) return null;

  switch (dialog.kind) {
    case "rename":
      return <RenameDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />;
    case "replace":
      return (
        <DeferredDialog
          load={loadReplace}
          title="Upload new version"
          open={open}
          onClose={onClose}
          props={{ entry, open, onOpenChange }}
        />
      );
    case "share":
      return (
        <DeferredDialog
          load={loadShare}
          title="Share"
          open={open}
          onClose={onClose}
          props={{ entry, open, onOpenChange }}
        />
      );
    case "versions":
      return (
        <DeferredDialog
          load={loadVersions}
          title="Version history"
          open={open}
          onClose={onClose}
          props={{
            entry,
            open,
            onOpenChange,
            onUploadNewVersion: () => onSelect({ kind: "replace", id: entry.id }),
          }}
        />
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

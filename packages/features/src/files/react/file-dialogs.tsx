import type { FileEntry } from "@hyori-cloud/client-sdk";
import { CreateFolderDialog } from "#features/files/react/create-folder-dialog.tsx";
import type { FileDialog, OpenFileDialog } from "#features/files/react/file-actions.tsx";
import { MoveDialog } from "#features/files/react/move-dialog.tsx";
import { RenameDialog } from "#features/files/react/rename-dialog.tsx";
import { VersionHistoryDialog } from "#features/files/react/version-history-dialog.tsx";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { isMediaType } from "#features/shared/format.ts";
import { ShareDialog } from "#features/sharing/react/share-dialog.tsx";

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
      <MoveDialog
        key={`${dialog.entry.id}:${dialog.entry.parentId}`}
        entry={dialog.entry}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }

  const entry = entries.find((candidate) => candidate.id === dialog.id);

  if (entry === undefined) return null;

  switch (dialog.kind) {
    case "rename":
      return <RenameDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />;
    case "share":
      return <ShareDialog key={entry.id} entry={entry} open={open} onOpenChange={onOpenChange} />;
    case "versions":
      return (
        <VersionHistoryDialog
          key={entry.id}
          entry={entry}
          open={open}
          onOpenChange={onOpenChange}
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

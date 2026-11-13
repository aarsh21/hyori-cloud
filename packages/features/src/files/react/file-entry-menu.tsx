import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Clock, Download, Move, Pencil, Share2, Trash2, Upload } from "@hyori-cloud/lib/icons";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { ItemActionMenu } from "@hyori-cloud/ui/components/item-action-menu";
import { OpenInEditorItem } from "#features/editors/react/open-in-editor-item.tsx";
import { useFileActions } from "#features/files/react/file-actions.tsx";

/** Offers only what this person may do. The server still authorizes every operation. */
export function FileEntryMenu({ entry }: { entry: FileEntry }) {
  const actions = useFileActions();
  const { access, kind } = entry;
  const canDownload = kind === "file" && access.canDownload;

  const hasSecondaryActions =
    canDownload || access.canEdit || access.canRename || access.canShare || access.isOwner;

  if (!hasSecondaryActions) return null;

  return (
    <ItemActionMenu label={`Actions for ${entry.name}`}>
      <OpenInEditorItem entry={entry} />
      {access.canShare ? (
        <DropdownMenuItem onClick={() => actions.openDialog({ kind: "share", id: entry.id })}>
          <Share2 />
          Share…
        </DropdownMenuItem>
      ) : null}
      {canDownload ? (
        <DropdownMenuItem onClick={() => actions.download(entry.id)}>
          <Download />
          Download
        </DropdownMenuItem>
      ) : null}
      {access.canEdit && kind === "file" ? (
        <DropdownMenuItem onClick={() => actions.openDialog({ kind: "replace", id: entry.id })}>
          <Upload />
          Upload new version…
        </DropdownMenuItem>
      ) : null}
      {access.canRename ? (
        <DropdownMenuItem onClick={() => actions.openDialog({ kind: "rename", id: entry.id })}>
          <Pencil />
          Rename…
          <DropdownMenuShortcut>F2</DropdownMenuShortcut>
        </DropdownMenuItem>
      ) : null}
      {access.isOwner ? (
        <DropdownMenuItem onClick={() => actions.openDialog({ kind: "move", entry })}>
          <Move />
          Move…
        </DropdownMenuItem>
      ) : null}
      {access.isOwner && kind === "file" ? (
        <DropdownMenuItem onClick={() => actions.openDialog({ kind: "versions", id: entry.id })}>
          <Clock />
          Version history…
        </DropdownMenuItem>
      ) : null}
      {access.canDelete ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => actions.trash(entry)}>
            <Trash2 />
            Move to Trash
            <DropdownMenuShortcut>Del</DropdownMenuShortcut>
          </DropdownMenuItem>
        </>
      ) : null}
    </ItemActionMenu>
  );
}

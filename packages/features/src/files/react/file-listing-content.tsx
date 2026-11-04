import type { FileEntry } from "@hyori-cloud/client-sdk";
import type { KeyboardEvent } from "@hyori-cloud/lib/react";
import {
  ItemActionSlot,
  ItemGrid,
  ItemName,
  ItemNavigation,
  ItemTable,
  ItemTableBody,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableRow,
  ItemTile,
  ItemTileLabel,
} from "@hyori-cloud/ui/components/item-collection";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { useFileActionPending, useFileActions } from "#features/files/react/file-actions.tsx";
import { FileEntryMenu } from "#features/files/react/file-entry-menu.tsx";
import { FileEntryTarget } from "#features/files/react/file-entry-target.tsx";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { formatBytes, formatDate } from "#features/shared/format.ts";

export type FileLayout = "list" | "grid";

function entryMeta(entry: FileEntry) {
  return entry.kind === "folder"
    ? formatDate(entry.updatedAt)
    : `${formatBytes(entry.size)} · ${formatDate(entry.updatedAt)}`;
}

export function FileListingContent({
  entries,
  layout,
  label,
}: {
  entries: readonly FileEntry[];
  layout: FileLayout;
  label: string;
}) {
  const actions = useFileActions();

  function onItemKeyDown(id: string, event: KeyboardEvent) {
    const entry = entries.find((candidate) => candidate.id === id);

    // Holding a key must not act again on an item that one press already acted on.
    if (entry === undefined || event.repeat) return;

    if (event.key === "F2" && entry.access.canEdit) {
      event.preventDefault();
      actions.openDialog({ kind: "rename", id });
    }

    if (event.key === "Delete" && entry.access.canDelete) {
      event.preventDefault();
      actions.trash(entry);
    }
  }

  return (
    <ItemNavigation
      itemKeys={entries.map((entry) => entry.id)}
      layout={layout}
      onItemKeyDown={onItemKeyDown}
    >
      {layout === "list" ? (
        <ItemTable>
          <ItemTableHeader>
            <ItemTableHeaderCell>Name</ItemTableHeaderCell>
            <ItemTableHeaderCell>Modified</ItemTableHeaderCell>
            <ItemTableHeaderCell>Size</ItemTableHeaderCell>
            <ItemTableHeaderCell />
          </ItemTableHeader>
          <ItemTableBody aria-label={label}>
            {entries.map((entry) => (
              <FileRow key={entry.id} entry={entry} />
            ))}
          </ItemTableBody>
        </ItemTable>
      ) : (
        <ItemGrid aria-label={label}>
          {entries.map((entry) => (
            <FileTile key={entry.id} entry={entry} />
          ))}
        </ItemGrid>
      )}
    </ItemNavigation>
  );
}

/** The icon slot shows progress, so a slow action gives feedback without moving anything. */
function FileEntryIcon({ entry }: { entry: FileEntry }) {
  if (useFileActionPending(entry.id)) return <Spinner label={`Working on ${entry.name}`} />;

  return <FileTypeIcon entry={entry} />;
}

function FileRow({ entry }: { entry: FileEntry }) {
  return (
    <ItemTableRow itemKey={entry.id} aria-busy={useFileActionPending(entry.id)}>
      <ItemTableCell className="flex">
        <FileEntryTarget entry={entry}>
          <ItemName icon={<FileEntryIcon entry={entry} />} meta={entryMeta(entry)}>
            {entry.name}
          </ItemName>
        </FileEntryTarget>
      </ItemTableCell>
      <ItemTableDetailCell>{formatDate(entry.updatedAt)}</ItemTableDetailCell>
      <ItemTableDetailCell>
        {entry.kind === "folder" ? "—" : formatBytes(entry.size)}
      </ItemTableDetailCell>
      <ItemTableCell className="overflow-visible">
        <ItemActionSlot>
          <FileEntryMenu entry={entry} />
        </ItemActionSlot>
      </ItemTableCell>
    </ItemTableRow>
  );
}

function FileTile({ entry }: { entry: FileEntry }) {
  return (
    <ItemTile
      itemKey={entry.id}
      aria-busy={useFileActionPending(entry.id)}
      preview={<FileEntryIcon entry={entry} />}
      action={<FileEntryMenu entry={entry} />}
    >
      <FileEntryTarget entry={entry}>
        <ItemTileLabel meta={entryMeta(entry)}>{entry.name}</ItemTileLabel>
      </FileEntryTarget>
    </ItemTile>
  );
}

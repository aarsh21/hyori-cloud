import type { FileEntry, FileList } from "@hyori-cloud/client-sdk";
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
import { ItemActionMenuScope } from "@hyori-cloud/ui/components/item-action-menu";
import { isAppShortcut } from "@hyori-cloud/ui/lib/browser";
import { VirtualItems } from "@hyori-cloud/ui/components/virtual-items";
import { useFileActionPending, useFileActions } from "#features/files/react/file-actions.tsx";
import { preloadFileDialogs } from "#features/files/react/file-dialog-loaders.ts";
import { FileEntryMenu } from "#features/files/react/file-entry-menu.tsx";
import { FileEntryTarget } from "#features/files/react/file-entry-target.tsx";
import FileThumbnail from "#features/files/react/file-thumbnail.tsx";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { NoSize } from "#features/files/react/no-size.tsx";
import { formatBytes, formatDateTime, formatRecentDate } from "#features/shared/format.ts";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";

export type FileLayout = "list" | "grid";

type ListingEntry = FileEntry & {
  readonly derivative?: NonNullable<FileList["thumbnails"]>[string];
};

/** Folders and notes have no size a person would act on: a note's bytes are its sync document. */
function hasSize(entry: FileEntry) {
  return entry.kind === "file" && entry.mimeType !== "application/vnd.hyori.note";
}

function entryMeta(entry: FileEntry, hydrated: boolean) {
  const date = hydrated ? formatRecentDate(entry.updatedAt) : "—";

  return hasSize(entry) ? `${formatBytes(entry.size)} · ${date}` : date;
}

function entryKey(entry: FileEntry) {
  return entry.id;
}

function renderRow(entry: ListingEntry) {
  return <FileRow entry={entry} />;
}

function renderTile(entry: ListingEntry) {
  return <FileTile entry={entry} />;
}

export function FileListingContent({
  entries,
  layout,
  label,
}: {
  entries: readonly ListingEntry[];
  layout: FileLayout;
  label: string;
}) {
  const actions = useFileActions();

  function onItemKeyDown(id: string, event: KeyboardEvent) {
    const entry = entries.find((candidate) => candidate.id === id);

    // Holding a key must not act again on an item that one press already acted on.
    if (entry === undefined || event.repeat) return;

    if (event.key === "F2" && entry.access.canRename) {
      event.preventDefault();
      actions.openDialog({ kind: "rename", id });
    }

    if (event.key === "Delete" && entry.access.canDelete) {
      event.preventDefault();
      actions.trash(entry);
    }

    // Space previews a file from the keyboard, the way a click now does. The native activation of
    // a focused row would have to be suppressed either way, so folders keep their own key.
    if (event.key === " " && entry.kind === "file" && isAppShortcut(event.nativeEvent)) {
      event.preventDefault();
      actions.openFile(entry);
    }
  }

  return (
    <ItemNavigation
      itemKeys={entries.map((entry) => entry.id)}
      layout={layout}
      onItemKeyDown={onItemKeyDown}
    >
      <ItemActionMenuScope
        onOpenChange={(open) => {
          if (open) preloadFileDialogs();
        }}
      >
        {layout === "list" ? (
          <ItemTable>
            <ItemTableHeader>
              <ItemTableHeaderCell>Name</ItemTableHeaderCell>
              <ItemTableHeaderCell>Modified</ItemTableHeaderCell>
              <ItemTableHeaderCell className="text-right">Size</ItemTableHeaderCell>
              <ItemTableHeaderCell />
            </ItemTableHeader>
            <VirtualItems
              items={entries}
              itemKey={entryKey}
              list={<ItemTableBody aria-label={label} />}
            >
              {renderRow}
            </VirtualItems>
          </ItemTable>
        ) : (
          <VirtualItems items={entries} itemKey={entryKey} list={<ItemGrid aria-label={label} />}>
            {renderTile}
          </VirtualItems>
        )}
      </ItemActionMenuScope>
    </ItemNavigation>
  );
}

/** The icon slot shows progress, so a slow action gives feedback without moving anything. */
function FileEntryIcon({ entry }: { entry: ListingEntry }) {
  if (useFileActionPending(entry.id)) return <Spinner label={`Working on ${entry.name}`} />;

  const icon = <FileTypeIcon entry={entry} />;

  if (!entry.derivative?.url) return icon;

  return <FileThumbnail key={entry.derivative.url} src={entry.derivative.url} fallback={icon} />;
}

function FileRow({ entry }: { entry: ListingEntry }) {
  // Local dates cannot be rendered in the server's locale/time zone without a mismatch.
  const hydrated = useHydrated();

  return (
    <ItemTableRow itemKey={entry.id} aria-busy={useFileActionPending(entry.id)}>
      <ItemTableCell className="flex">
        <FileEntryTarget entry={entry}>
          <ItemName icon={<FileEntryIcon entry={entry} />} meta={entryMeta(entry, hydrated)}>
            {entry.name}
          </ItemName>
        </FileEntryTarget>
      </ItemTableCell>
      <ItemTableDetailCell title={hydrated ? formatDateTime(entry.updatedAt) : undefined}>
        {hydrated ? formatRecentDate(entry.updatedAt) : "—"}
      </ItemTableDetailCell>
      <ItemTableDetailCell className="text-right">
        {hasSize(entry) ? formatBytes(entry.size) : <NoSize />}
      </ItemTableDetailCell>
      <ItemTableCell className="overflow-visible">
        <ItemActionSlot>
          <FileEntryMenu entry={entry} />
        </ItemActionSlot>
      </ItemTableCell>
    </ItemTableRow>
  );
}

function FileTile({ entry }: { entry: ListingEntry }) {
  const hydrated = useHydrated();

  return (
    <ItemTile
      itemKey={entry.id}
      aria-busy={useFileActionPending(entry.id)}
      preview={<FileEntryIcon entry={entry} />}
      action={<FileEntryMenu entry={entry} />}
    >
      <FileEntryTarget entry={entry}>
        <ItemTileLabel meta={entryMeta(entry, hydrated)}>{entry.name}</ItemTileLabel>
      </FileEntryTarget>
    </ItemTile>
  );
}

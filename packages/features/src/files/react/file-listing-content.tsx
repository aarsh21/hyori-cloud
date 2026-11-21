import type { FileEntry, FileList } from "@hyori-cloud/client-sdk";
import { Link2, Users } from "@hyori-cloud/lib/icons";
import { createContext, useContext } from "@hyori-cloud/lib/react";
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
import {
  formatBytes,
  formatDateTime,
  formatItemCount,
  formatRecentDate,
} from "#features/shared/format.ts";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";

export type FileLayout = "list" | "grid";

type SharingSummary = NonNullable<FileList["sharing"]>[string];

type ListingEntry = FileList["items"][number] & {
  readonly derivative?: NonNullable<FileList["thumbnails"]>[string];
  /** Present only for the owner's items with live direct shares. */
  readonly sharing?: SharingSummary | undefined;
};

/** Folders and notes have no size a person would act on: a note's bytes are its sync document. */
function hasSize(entry: FileEntry) {
  return entry.kind === "file" && entry.mimeType !== "application/vnd.hyori.note";
}

/** Size for files, the number of direct items for folders, and nothing for notes. */
function entrySize(entry: ListingEntry) {
  if (hasSize(entry)) return formatBytes(entry.size);

  return entry.childCount === undefined ? null : formatItemCount(entry.childCount);
}

/** Phone rows and grid tiles have one line, so it carries the size, the date and sharing. */
function entryMeta(entry: ListingEntry, hydrated: boolean) {
  const date = hydrated ? formatRecentDate(entry.updatedAt) : "—";

  return [entrySize(entry), date, entry.sharing ? "Shared" : null].filter(Boolean).join(" · ");
}

function sharingLabel({ peopleCount, hasLink }: SharingSummary) {
  const people = peopleCount === 1 ? "1 person" : `${peopleCount} people`;

  if (peopleCount === 0) return "Shared by link";

  return hasLink ? `Shared with ${people} and by link` : `Shared with ${people}`;
}

/** People and link glyphs; the label carries the words for screen readers and on hover. */
function SharingCell({ sharing }: { sharing: SharingSummary | undefined }) {
  if (sharing === undefined) return null;
  const label = sharingLabel(sharing);

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-2 text-muted-foreground tabular-nums [&_svg]:size-3.5 [&_svg]:stroke-[1.75]"
    >
      {sharing.peopleCount > 0 ? (
        <span className="inline-flex items-center gap-1">
          <Users aria-hidden />
          {sharing.peopleCount}
        </span>
      ) : null}
      {sharing.hasLink ? <Link2 aria-hidden /> : null}
    </span>
  );
}

function entryKey(entry: ListingEntry) {
  return entry.id;
}

/** Whether this page shows the Sharing column: only when the owner has shared something on it. */
const SharingColumn = createContext(false);

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
  const showSharing = entries.some((entry) => entry.sharing !== undefined);

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
        sheet
        onOpenChange={(open) => {
          if (open) preloadFileDialogs();
        }}
      >
        {layout === "list" ? (
          <ItemTable
            className={
              showSharing
                ? "[--item-columns:minmax(0,1fr)_2.25rem] @2xl:[--item-columns:minmax(0,1fr)_4.5rem_10rem_6rem_2.25rem]"
                : undefined
            }
          >
            <ItemTableHeader>
              <ItemTableHeaderCell>Name</ItemTableHeaderCell>
              {showSharing ? <ItemTableHeaderCell>Sharing</ItemTableHeaderCell> : null}
              <ItemTableHeaderCell>Modified</ItemTableHeaderCell>
              <ItemTableHeaderCell className="text-right">Size</ItemTableHeaderCell>
              <ItemTableHeaderCell />
            </ItemTableHeader>
            <SharingColumn value={showSharing}>
              <VirtualItems
                items={entries}
                itemKey={entryKey}
                list={<ItemTableBody aria-label={label} />}
              >
                {renderRow}
              </VirtualItems>
            </SharingColumn>
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
      {useContext(SharingColumn) ? (
        <ItemTableDetailCell>
          <SharingCell sharing={entry.sharing} />
        </ItemTableDetailCell>
      ) : null}
      <ItemTableDetailCell title={hydrated ? formatDateTime(entry.updatedAt) : undefined}>
        {hydrated ? formatRecentDate(entry.updatedAt) : "—"}
      </ItemTableDetailCell>
      <ItemTableDetailCell className="text-right tabular-nums">
        {entrySize(entry) ?? <NoSize />}
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

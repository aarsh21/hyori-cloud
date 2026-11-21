import type { FileEntry, FileList } from "@hyori-cloud/client-sdk";
import { Trash2 } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import {
  PageBar,
  PageBarActions,
  PageBody,
  PageSection,
  PageTitle,
} from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { DropdownMenuItem } from "@hyori-cloud/ui/components/dropdown-menu";
import { ItemActionMenu } from "@hyori-cloud/ui/components/item-action-menu";
import {
  ItemName,
  ItemNavigation,
  ItemTable,
  ItemTableBody,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableRow,
  ItemTableSkeleton,
  useItemTabIndex,
} from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { VirtualItems } from "@hyori-cloud/ui/components/virtual-items";
import { DeletePermanentlyDialog } from "#features/files/react/delete-permanently-dialog.tsx";
import { EmptyTrashDialog } from "#features/files/react/empty-trash-dialog.tsx";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { NoSize } from "#features/files/react/no-size.tsx";
import { useFileListing } from "#features/files/react/use-file-listing.ts";
import { useRestoreFile } from "#features/files/react/use-file-mutations.ts";
import {
  formatBytes,
  formatDateTime,
  formatRecentDate,
  formatRecentDay,
} from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

type TrashEntry = FileList["items"][number];

/**
 * Where an item was when it was deleted, root first. The names are a record from that moment, so
 * they read as plain text: a parent renamed since is not a link. Older servers don't say.
 */
function originalLocation(entry: TrashEntry) {
  const path = entry.originalParentPath;

  return path === undefined ? null : ["Files", ...path].join(" › ");
}

export function TrashScreen() {
  const listing = useFileListing({ view: "trash" });
  const restore = useRestoreFile();
  // Each confirmation keeps its target while closing, after the row has already left Trash.
  const [deleting, setDeleting] = useState<{ entry: FileEntry; open: boolean } | null>(null);
  const [emptying, setEmptying] = useState(false);
  const hasEntries = listing.data?.pages.some((page) => page.items.length > 0) ?? false;

  function renderBody() {
    if (listing.data === undefined) {
      return <QueryWaiting resource={listing} pending={<ItemTableSkeleton />} />;
    }

    const entries = listing.data.pages.flatMap((page) => page.items);

    return (
      <>
        {listing.isRefetchError ? (
          <RefreshFailure error={listing.error} onRetry={() => listing.refetch()} />
        ) : null}
        {entries.length === 0 ? (
          <RegionState
            icon={<Trash2 />}
            title="Trash is empty"
            description="Things you delete appear here, ready to restore."
          />
        ) : (
          <ItemNavigation itemKeys={entries.map((entry) => entry.id)} layout="list">
            <ItemTable className="[--item-columns:minmax(0,1fr)_auto] @2xl:[--item-columns:minmax(0,1fr)_minmax(0,14rem)_10rem_6rem_8.5rem]">
              <ItemTableHeader>
                <ItemTableHeaderCell>Name</ItemTableHeaderCell>
                <ItemTableHeaderCell>Original location</ItemTableHeaderCell>
                <ItemTableHeaderCell>Deleted</ItemTableHeaderCell>
                <ItemTableHeaderCell className="text-right">Size</ItemTableHeaderCell>
                <ItemTableHeaderCell />
              </ItemTableHeader>
              <VirtualItems
                items={entries}
                itemKey={(entry) => entry.id}
                list={<ItemTableBody aria-label="Trash" />}
              >
                {(entry) => (
                  <TrashRow
                    entry={entry}
                    restoring={restore.isPending && restore.variables.id === entry.id}
                    onRestore={() => restore.mutate({ id: entry.id })}
                    onDelete={() => setDeleting({ entry, open: true })}
                  />
                )}
              </VirtualItems>
            </ItemTable>
          </ItemNavigation>
        )}
        <LoadMore pages={listing} />
      </>
    );
  }

  return (
    <>
      <PageBar>
        <PageTitle>Trash</PageTitle>
        {hasEntries ? (
          <PageBarActions>
            <Button type="button" size="sm" variant="outline" onClick={() => setEmptying(true)}>
              Empty Trash…
            </Button>
          </PageBarActions>
        ) : null}
      </PageBar>
      <PageBody scrollRestorationId="trash">
        <PageSection>
          <MutationFailure error={restore.error} />
          {renderBody()}
        </PageSection>
      </PageBody>
      <EmptyTrashDialog open={emptying} onOpenChange={setEmptying} />
      {deleting === null ? null : (
        <DeletePermanentlyDialog
          key={deleting.entry.id}
          entry={deleting.entry}
          open={deleting.open}
          onOpenChange={(open) => setDeleting({ ...deleting, open })}
        />
      )}
    </>
  );
}

function TrashRow({
  entry,
  restoring,
  onRestore,
  onDelete,
}: {
  entry: TrashEntry;
  restoring: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const deletedAt = entry.trashedAt ?? entry.updatedAt;
  const location = originalLocation(entry);
  // One line on phones: the folder it came from leads, so truncation takes the date, not the place.
  const from = entry.originalParentPath?.at(-1) ?? (location === null ? null : "Files");
  const meta = `Deleted ${formatRecentDay(deletedAt)}`;

  return (
    <ItemTableRow itemKey={entry.id}>
      <ItemTableCell className="flex">
        <ItemName
          icon={<FileTypeIcon entry={entry} />}
          meta={from === null ? meta : `From ${from} · ${meta}`}
        >
          {entry.name}
        </ItemName>
      </ItemTableCell>
      <ItemTableDetailCell className="truncate" title={location ?? undefined}>
        {location ?? <NoSize />}
      </ItemTableDetailCell>
      <ItemTableDetailCell title={formatDateTime(deletedAt)}>
        {formatRecentDate(deletedAt)}
      </ItemTableDetailCell>
      <ItemTableDetailCell className="text-right">
        {entry.kind === "folder" ? <NoSize /> : formatBytes(entry.size)}
      </ItemTableDetailCell>
      <ItemTableCell className="flex justify-end gap-1 overflow-visible">
        <RestoreButton restoring={restoring} onRestore={onRestore} />
        <ItemActionMenu label={`More actions for ${entry.name}`}>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            Delete permanently…
          </DropdownMenuItem>
        </ItemActionMenu>
      </ItemTableCell>
    </ItemTableRow>
  );
}

/**
 * The row's one action is also its keyboard target, so restoring moves focus to the row that takes
 * its place instead of dropping it. Unlike a file's name, it must not claim the whole row as its
 * click area: a stray tap in Trash shouldn't restore anything.
 */
function RestoreButton({ restoring, onRestore }: { restoring: boolean; onRestore: () => void }) {
  return (
    <Button
      data-item-target
      tabIndex={useItemTabIndex()}
      size="sm"
      variant="outline"
      className="scroll-mt-9 after:hidden!"
      pending={restoring}
      pendingLabel="Restoring…"
      onClick={onRestore}
    >
      Restore
    </Button>
  );
}

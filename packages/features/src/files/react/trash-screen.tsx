import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Trash2 } from "@hyori-cloud/lib/icons";
import { PageBar, PageBody, PageSection, PageTitle } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
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
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { NoSize } from "#features/files/react/no-size.tsx";
import { useFileListing } from "#features/files/react/use-file-listing.ts";
import { useRestoreFile } from "#features/files/react/use-file-mutations.ts";
import { formatBytes, formatDateTime, formatRecentDate } from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

export function TrashScreen() {
  const listing = useFileListing({ view: "trash" });
  const restore = useRestoreFile();

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
            <ItemTable className="[--item-columns:minmax(0,1fr)_auto] @2xl:[--item-columns:minmax(0,1fr)_10rem_6rem_6.5rem]">
              <ItemTableHeader>
                <ItemTableHeaderCell>Name</ItemTableHeaderCell>
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
      </PageBar>
      <PageBody>
        <PageSection>
          <MutationFailure error={restore.error} />
          {renderBody()}
        </PageSection>
      </PageBody>
    </>
  );
}

function TrashRow({
  entry,
  restoring,
  onRestore,
}: {
  entry: FileEntry;
  restoring: boolean;
  onRestore: () => void;
}) {
  const deletedAt = entry.trashedAt ?? entry.updatedAt;

  return (
    <ItemTableRow itemKey={entry.id}>
      <ItemTableCell className="flex">
        <ItemName
          icon={<FileTypeIcon entry={entry} />}
          meta={`Deleted ${formatRecentDate(deletedAt)}`}
        >
          {entry.name}
        </ItemName>
      </ItemTableCell>
      <ItemTableDetailCell title={formatDateTime(deletedAt)}>
        {formatRecentDate(deletedAt)}
      </ItemTableDetailCell>
      <ItemTableDetailCell className="text-right">
        {entry.kind === "folder" ? <NoSize /> : formatBytes(entry.size)}
      </ItemTableDetailCell>
      <ItemTableCell className="flex justify-end overflow-visible">
        <RestoreButton restoring={restoring} onRestore={onRestore} />
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

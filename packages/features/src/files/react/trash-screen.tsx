import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Trash2 } from "@hyori-cloud/lib/icons";
import { PageBar, PageBody, PageSection, PageTitle } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  ItemName,
  ItemTable,
  ItemTableBody,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableRow,
  ItemTableSkeleton,
} from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { useFileListing } from "#features/files/react/use-file-listing.ts";
import { useRestoreFile } from "#features/files/react/use-file-mutations.ts";
import { formatBytes, formatDate } from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { OfflineState } from "#features/shared/react/offline-state.tsx";
import { QueryFailure } from "#features/shared/react/query-failure.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

export function TrashScreen() {
  const listing = useFileListing({ view: "trash" });
  const restore = useRestoreFile();

  function renderBody() {
    if (listing.data === undefined) {
      if (listing.error !== null) {
        return <QueryFailure error={listing.error} onRetry={() => listing.refetch()} />;
      }

      if (listing.fetchStatus === "paused") return <OfflineState />;

      return <ItemTableSkeleton />;
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
          <ItemTable className="[--item-columns:minmax(0,1fr)_auto] @2xl:[--item-columns:minmax(0,1fr)_10rem_6rem_6.5rem]">
            <ItemTableHeader>
              <ItemTableHeaderCell>Name</ItemTableHeaderCell>
              <ItemTableHeaderCell>Deleted</ItemTableHeaderCell>
              <ItemTableHeaderCell className="text-right">Size</ItemTableHeaderCell>
              <ItemTableHeaderCell />
            </ItemTableHeader>
            <ItemTableBody aria-label="Trash">
              {entries.map((entry) => (
                <TrashRow
                  key={entry.id}
                  entry={entry}
                  restoring={restore.isPending && restore.variables.id === entry.id}
                  onRestore={() => restore.mutate({ id: entry.id })}
                />
              ))}
            </ItemTableBody>
          </ItemTable>
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
        <ItemName icon={<FileTypeIcon entry={entry} />} meta={`Deleted ${formatDate(deletedAt)}`}>
          {entry.name}
        </ItemName>
      </ItemTableCell>
      <ItemTableDetailCell>{formatDate(deletedAt)}</ItemTableDetailCell>
      <ItemTableDetailCell className="text-right">
        {entry.kind === "folder" ? "—" : formatBytes(entry.size)}
      </ItemTableDetailCell>
      <ItemTableCell className="flex justify-end overflow-visible">
        <Button
          size="sm"
          variant="outline"
          pending={restoring}
          pendingLabel="Restoring…"
          onClick={onRestore}
        >
          Restore
        </Button>
      </ItemTableCell>
    </ItemTableRow>
  );
}

import type { ReactNode } from "@hyori-cloud/lib/react";
import { Search } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { ItemGridSkeleton, ItemTableSkeleton } from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Stack } from "@hyori-cloud/ui/components/text";
import { FileListingContent } from "#features/files/react/file-listing-content.tsx";
import type { FileLayout } from "#features/files/react/file-listing-content.tsx";
import type { FileListing } from "#features/files/react/use-file-listing.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { OfflineState } from "#features/shared/react/offline-state.tsx";
import { QueryFailure } from "#features/shared/react/query-failure.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

/** Data first: anything already loaded stays on screen through refreshes and their failures. */
export function FileListingView({
  listing,
  layout,
  label,
  filtering,
  onClearFilters,
  empty,
}: {
  listing: FileListing;
  layout: FileLayout;
  label: string;
  filtering: boolean;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  if (listing.data === undefined) {
    if (listing.error !== null) {
      return <QueryFailure error={listing.error} onRetry={() => listing.refetch()} />;
    }

    if (listing.fetchStatus === "paused") return <OfflineState />;

    return layout === "list" ? <ItemTableSkeleton /> : <ItemGridSkeleton />;
  }

  return (
    <LoadedListing
      listing={listing}
      layout={layout}
      label={label}
      filtering={filtering}
      onClearFilters={onClearFilters}
      empty={empty}
    />
  );
}

function LoadedListing({
  listing,
  layout,
  label,
  filtering,
  onClearFilters,
  empty,
}: {
  listing: FileListing;
  layout: FileLayout;
  label: string;
  filtering: boolean;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  const entries = listing.data?.pages.flatMap((page) => page.items) ?? [];

  // Retained rows belong to the previous filters, so an empty set says nothing about these ones.
  if (listing.isPlaceholderData && entries.length === 0) {
    return layout === "list" ? <ItemTableSkeleton /> : <ItemGridSkeleton />;
  }

  return (
    <>
      {listing.isRefetchError ? (
        <RefreshFailure error={listing.error} onRetry={() => listing.refetch()} />
      ) : null}
      {entries.length > 0 ? (
        <Stack
          aria-busy={listing.isPlaceholderData}
          // The delay keeps a fast response from flickering; only a slow one dims the old rows.
          className={
            listing.isPlaceholderData
              ? "opacity-60 transition-opacity delay-150 duration-150"
              : "transition-opacity duration-100"
          }
        >
          <FileListingContent entries={entries} layout={layout} label={label} />
        </Stack>
      ) : (
        <NoEntries filtering={filtering} onClearFilters={onClearFilters} empty={empty} />
      )}
      {listing.isPlaceholderData ? null : <LoadMore pages={listing} />}
    </>
  );
}

function NoEntries({
  filtering,
  onClearFilters,
  empty,
}: {
  filtering: boolean;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  if (!filtering) return empty;

  return (
    <RegionState
      role="status"
      icon={<Search />}
      title="Nothing matches"
      description="Search looks at file and folder names, not what’s inside files."
      action={
        <Button variant="outline" onClick={onClearFilters}>
          Clear filters
        </Button>
      }
    />
  );
}

import type { ReactNode } from "@hyori-cloud/lib/react";
import { Search } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { ItemGridSkeleton, ItemTableSkeleton } from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Stack } from "@hyori-cloud/ui/components/text";
import { hasActiveFilters, type FileFilters } from "#features/files/file-filters.ts";
import { FileListingContent } from "#features/files/react/file-listing-content.tsx";
import type { FileLayout } from "#features/files/react/file-listing-content.tsx";
import type { FileListing } from "#features/files/react/use-file-listing.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

/** Data first: anything already loaded stays on screen through refreshes and their failures. */
export function FileListingView({
  listing,
  layout,
  label,
  filters,
  onClearFilters,
  empty,
}: {
  listing: FileListing;
  layout: FileLayout;
  label: string;
  filters: FileFilters;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  if (listing.data === undefined) {
    return (
      <QueryWaiting
        resource={listing}
        pending={layout === "list" ? <ItemTableSkeleton /> : <ItemGridSkeleton />}
      />
    );
  }

  return (
    <LoadedListing
      listing={listing}
      layout={layout}
      label={label}
      filters={filters}
      onClearFilters={onClearFilters}
      empty={empty}
    />
  );
}

function LoadedListing({
  listing,
  layout,
  label,
  filters,
  onClearFilters,
  empty,
}: {
  listing: FileListing;
  layout: FileLayout;
  label: string;
  filters: FileFilters;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  const entries =
    listing.data?.pages.flatMap((page) =>
      page.items.map((entry) => ({
        ...entry,
        derivative: page.thumbnails?.[entry.id],
        sharing: page.sharing?.[entry.id],
      })),
    ) ?? [];

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
        <NoEntries filters={filters} onClearFilters={onClearFilters} empty={empty} />
      )}
      {listing.isPlaceholderData ? null : <LoadMore pages={listing} />}
    </>
  );
}

function NoEntries({
  filters,
  onClearFilters,
  empty,
}: {
  filters: FileFilters;
  onClearFilters: () => void;
  empty: ReactNode;
}) {
  if (!hasActiveFilters(filters)) return empty;

  const onlySearch = !hasActiveFilters({ ...filters, search: "" });

  return (
    <RegionState
      role="status"
      icon={<Search />}
      title={filters.search === "" ? "No matches" : `No matches for “${filters.search}”`}
      description={
        onlySearch
          ? "Search looks at file and folder names, not what’s inside files."
          : "Try another name or clear the filters."
      }
      action={
        <Button variant="outline" onClick={onClearFilters}>
          {onlySearch ? "Clear search" : "Clear filters"}
        </Button>
      }
    />
  );
}

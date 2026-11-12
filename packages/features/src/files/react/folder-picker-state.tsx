import { PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { InlineText } from "@hyori-cloud/ui/components/text";
import type { FileListing } from "#features/files/react/use-file-listing.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { PickerFailureRow } from "#features/shared/react/picker-failure-row.tsx";

/** Everything a folder list can show besides its rows, all inside the list's fixed-height frame. */
export function FolderPickerState({
  listing,
  isEmpty,
}: {
  listing: FileListing;
  isEmpty: boolean;
}) {
  if (listing.data === undefined) {
    if (listing.error !== null) {
      return <PickerFailureRow error={listing.error} onRetry={() => listing.refetch()} />;
    }

    return (
      <>
        {["w-1/2", "w-1/3", "w-2/5"].map((width) => (
          <PickerRow key={width} className="px-2 hover:bg-transparent">
            <Skeleton className={`h-3 ${width}`} />
          </PickerRow>
        ))}
      </>
    );
  }

  if (isEmpty) {
    return (
      <PickerRow className="px-2 hover:bg-transparent">
        <InlineText tone="muted">No folders in here</InlineText>
      </PickerRow>
    );
  }

  return <LoadMore pages={listing} />;
}

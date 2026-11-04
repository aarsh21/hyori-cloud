import { Button } from "@hyori-cloud/ui/components/button";
import { PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { InlineText } from "@hyori-cloud/ui/components/text";
import type { FileListing } from "#features/files/react/use-file-listing.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";

/** Everything a folder list can show besides its rows, all inside the list's fixed-height frame. */
export function FolderPickerState({
  listing,
  isEmpty,
}: {
  listing: FileListing;
  isEmpty: boolean;
}) {
  const recovery = useAccessRecovery(listing.error);

  if (listing.data === undefined) {
    if (listing.error !== null) {
      return (
        <PickerRow className="justify-between px-2 hover:bg-transparent">
          <InlineText tone="destructive" truncate>
            {(recovery ?? describeCloudError(listing.error)).title}
          </InlineText>
          {recovery === null ? (
            <Button type="button" size="xs" variant="outline" onClick={() => listing.refetch()}>
              Try again
            </Button>
          ) : (
            <AccessRecoveryButton recovery={recovery} size="xs" />
          )}
        </PickerRow>
      );
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

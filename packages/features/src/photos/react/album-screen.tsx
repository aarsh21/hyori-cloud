import { Images } from "@hyori-cloud/lib/icons";
import { PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { SectionHeading } from "@hyori-cloud/ui/components/text";
import { localDateInputValue } from "#features/shared/format.ts";
import { thumbnailProgressSummary } from "#features/photos/photo-derivative.ts";
import type { PhotoItem } from "#features/photos/photo-derivative.ts";
import { PhotoTimeline } from "#features/photos/react/photo-timeline.tsx";
import { PhotosBar } from "#features/photos/react/photos-bar.tsx";
import { useAlbums, usePhotoTimeline } from "#features/photos/react/use-photos.ts";

/**
 * An album holds no timeline dates of its own; its items group by the day they were uploaded, in
 * the order the album's own feed keeps.
 */
function albumDayKey(item: PhotoItem): string {
  return localDateInputValue(new Date(item.createdAt));
}

export function AlbumScreen({ albumId }: { albumId: string }) {
  const timeline = usePhotoTimeline(albumId);
  const albums = useAlbums();
  const name = albums.data?.items.find((album) => album.id === albumId)?.name;

  return (
    <>
      <PhotosBar status={thumbnailProgressSummary(timeline.data?.pages ?? [])} />
      <PageBody>
        <PageSection>
          {/* Holds its line while albums load, so the photos below don't move when the name lands. */}
          <SectionHeading className="flex min-h-5 items-center px-1 text-[15px]">
            {name ??
              (albums.data === undefined && albums.error === null ? (
                <Skeleton className="h-3 w-24" />
              ) : null)}
          </SectionHeading>
          <PhotoTimeline
            timeline={timeline}
            dayKeyOf={albumDayKey}
            empty={
              <RegionState
                icon={<Images />}
                title="This album is empty"
                description="Open a photo in your timeline and add it from the viewer."
              />
            }
          />
        </PageSection>
      </PageBody>
    </>
  );
}

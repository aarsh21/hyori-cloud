import { Images } from "@hyori-cloud/lib/icons";
import { PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { SectionHeading } from "@hyori-cloud/ui/components/text";
import { PhotoTimeline } from "#features/photos/react/photo-timeline.tsx";
import { PhotosBar } from "#features/photos/react/photos-bar.tsx";
import { useAlbums, usePhotoTimeline } from "#features/photos/react/use-photos.ts";

export function AlbumScreen({ albumId }: { albumId: string }) {
  const timeline = usePhotoTimeline(albumId);
  const albums = useAlbums();
  const name = albums.data?.items.find((album) => album.id === albumId)?.name;

  return (
    <>
      <PhotosBar />
      <PageBody>
        <PageSection>
          {name === undefined ? null : (
            <SectionHeading className="px-1 text-[15px]">{name}</SectionHeading>
          )}
          <PhotoTimeline
            timeline={timeline}
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

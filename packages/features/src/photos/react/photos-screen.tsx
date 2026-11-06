import { Images, SlidersHorizontal } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { MediaGridSkeleton } from "@hyori-cloud/ui/components/media-grid";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { thumbnailProgressSummary } from "#features/photos/photo-derivative.ts";
import { PhotoSourcesDialog } from "#features/photos/react/photo-sources-dialog.tsx";
import { PhotoTimeline } from "#features/photos/react/photo-timeline.tsx";
import { PhotosBar } from "#features/photos/react/photos-bar.tsx";
import { PhotosSetup } from "#features/photos/react/photos-setup.tsx";
import type { PhotoSourcesValue } from "#features/photos/react/source-selection.tsx";
import { usePhotoSources, usePhotoTimeline } from "#features/photos/react/use-photos.ts";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";

export function PhotosScreen() {
  const sources = usePhotoSources();

  if (sources.data === undefined) {
    return (
      <>
        <PhotosBar />
        <PageBody>
          <PageSection>
            <QueryWaiting resource={sources} pending={<MediaGridSkeleton />} />
          </PageSection>
        </PageBody>
      </>
    );
  }

  const configured = sources.data.allMyFiles || sources.data.folderIds.length > 0;

  if (!configured) {
    return (
      <>
        <PhotosBar />
        <PhotosSetup />
      </>
    );
  }

  return <PhotosLibrary saved={sources.data} />;
}

function PhotosLibrary({ saved }: { saved: PhotoSourcesValue }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const timeline = usePhotoTimeline();

  return (
    <>
      <PhotosBar
        status={thumbnailProgressSummary(timeline.data?.pages ?? [])}
        actions={
          <Button variant="ghost" onClick={() => setSourcesOpen(true)}>
            <SlidersHorizontal aria-hidden />
            Sources
          </Button>
        }
      />
      <PageBody>
        <PageSection>
          <PhotoTimeline
            timeline={timeline}
            empty={
              <RegionState
                icon={<Images />}
                title="No photos found yet"
                description="New images and videos in your sources appear here automatically."
                action={
                  <Button variant="outline" onClick={() => setSourcesOpen(true)}>
                    Change sources
                  </Button>
                }
              />
            }
          />
        </PageSection>
      </PageBody>
      <PhotoSourcesDialog saved={saved} open={sourcesOpen} onOpenChange={setSourcesOpen} />
    </>
  );
}

import { Images, Upload } from "@hyori-cloud/lib/icons";
import { useRef } from "@hyori-cloud/lib/react";
import { PageBody, PageSection } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { DropZone, FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { thumbnailProgressSummary } from "#features/photos/photo-derivative.ts";
import { PhotoInfoPanel } from "#features/photos/react/photo-info.tsx";
import { PhotoTimeline } from "#features/photos/react/photo-timeline.tsx";
import { PhotosBar } from "#features/photos/react/photos-bar.tsx";
import { usePhotoLibrary } from "#features/photos/react/use-photos.ts";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

/**
 * The photo library needs no setup: media you own appears here as the server discovers it, wherever
 * in your files it lives, grouped by the day it was taken. Uploading from this screen lands in the
 * top of your files and joins the timeline the same way.
 */
export function PhotosScreen() {
  const timeline = usePhotoLibrary();
  const queue = useUploadQueue();
  const picker = useRef<FilePickerHandle>(null);

  function addFiles(files: File[]) {
    queue.add(files, null);
  }

  function upload() {
    picker.current?.open();
  }

  return (
    <>
      <PhotosBar
        status={thumbnailProgressSummary(timeline.data?.pages ?? [])}
        actions={
          <Button onClick={upload}>
            <Upload aria-hidden />
            Upload
          </Button>
        }
      />
      <FilePicker accept="image/*,video/*" onFiles={addFiles} ref={picker} />
      <DropZone label="Drop to upload to Files" onFiles={addFiles}>
        <PageBody scrollRestorationId="photos">
          <PageSection>
            <PhotoTimeline
              timeline={timeline}
              // The server names the day each item was taken, as the timeline groups them.
              dayKeyOf={(item) => item.timelineDate}
              scrubber
              viewerInfo={(item) => <PhotoInfoPanel item={item} />}
              empty={
                <RegionState
                  icon={<Images />}
                  title="No photos yet"
                  description="Photos and videos you upload appear here automatically."
                  action={
                    <Button onClick={upload}>
                      <Upload aria-hidden />
                      Upload photos
                    </Button>
                  }
                />
              }
            />
          </PageSection>
        </PageBody>
      </DropZone>
    </>
  );
}

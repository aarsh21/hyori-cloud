import type { FileEntry } from "@hyori-cloud/client-sdk";
import { FileImage, Play } from "@hyori-cloud/lib/icons";
import {
  MediaTileButton,
  MediaTileFrame,
  MediaTileImage,
  MediaTilePlaceholder,
} from "@hyori-cloud/ui/components/media-grid";
import { useEnteredViewport } from "@hyori-cloud/ui/hooks/use-entered-viewport";

/**
 * Starts loading its image only once scrolled near view, so a long timeline stays bounded. Videos
 * show a placeholder: the API has no derived poster frame, and a video URL can't fill an image tile.
 */
export function PhotoTile({
  item,
  previewUrl,
  onOpen,
}: {
  item: FileEntry;
  previewUrl: string;
  onOpen: (id: string) => void;
}) {
  const [entered, ref] = useEnteredViewport<HTMLLIElement>();
  const isVideo = item.mimeType.startsWith("video/");

  const placeholder = (
    <MediaTilePlaceholder>
      {isVideo ? <Play aria-hidden /> : <FileImage aria-hidden />}
    </MediaTilePlaceholder>
  );

  return (
    <MediaTileFrame ref={ref} itemKey={item.id}>
      <MediaTileButton label={item.name} onClick={() => onOpen(item.id)}>
        {entered && !isVideo ? (
          <MediaTileImage src={previewUrl} fallback={placeholder} />
        ) : (
          placeholder
        )}
      </MediaTileButton>
    </MediaTileFrame>
  );
}

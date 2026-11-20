import { FileImage, Play, RotateCcw } from "@hyori-cloud/lib/icons";
import {
  MediaTileAction,
  MediaTileBadge,
  MediaTileButton,
  MediaTileFrame,
  MediaTileImage,
  MediaTilePlaceholder,
} from "@hyori-cloud/ui/components/media-grid";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { useEnteredViewport } from "@hyori-cloud/ui/hooks/use-entered-viewport";
import type { PhotoItem } from "#features/photos/photo-derivative.ts";
import { photoTileCaption, photoTileStatus } from "#features/photos/photo-derivative.ts";
import { useRetryThumbnail } from "#features/photos/react/use-photos.ts";

/**
 * The frame and its button stay mounted through every thumbnail state, so a state change never
 * takes keyboard focus or the tile's place with it. Tiles carry their state from the one timeline
 * read and make no requests of their own, except a retry someone asks for.
 */
export function PhotoTile({
  item,
  onOpen,
}: {
  item: PhotoItem;
  onOpen: (id: string, origin: DOMRect | null) => void;
}) {
  const [entered, ref] = useEnteredViewport<HTMLLIElement>("0px");
  const retry = useRetryThumbnail();
  const { derivative } = item;
  const canRetry = derivative?.status === "failed" && derivative.canRetry;
  const retryRefused = canRetry && retry.error !== null;
  const refusal = retryRefused ? "Couldn’t retry" : null;
  const status = refusal ?? photoTileStatus(derivative);
  const caption = refusal ?? photoTileCaption(derivative);

  return (
    <MediaTileFrame ref={ref} itemKey={item.id}>
      <MediaTileButton
        label={photoTileLabel(item, status)}
        // The tile's own rect flies the viewer out of it, the same for a tap and a keyboard open.
        onClick={() => onOpen(item.id, ref.current?.getBoundingClientRect() ?? null)}
      >
        <PhotoTileContent item={item} entered={entered} caption={caption} />
      </MediaTileButton>
      {canRetry ? (
        <MediaTileAction
          label={`Retry thumbnail of ${item.name}`}
          pending={retry.isPending}
          announcement={retryRefused ? `Couldn’t retry the thumbnail of ${item.name}.` : null}
          onClick={() => retry.mutate({ id: item.id })}
        >
          {retry.isPending ? (
            <Spinner label="Retrying" className="text-current" />
          ) : (
            <RotateCcw aria-hidden />
          )}
        </MediaTileAction>
      ) : null}
    </MediaTileFrame>
  );
}

function photoTileLabel({ name, derivative }: PhotoItem, status: string | null) {
  if (status !== null) return `${name}. ${status}.`;

  return derivative?.status === "ready" && derivative.kind === "poster" ? `${name}. Video.` : name;
}

function PhotoTileContent({
  item,
  entered,
  caption,
}: {
  item: PhotoItem;
  entered: boolean;
  caption: string | null;
}) {
  const { derivative } = item;
  const isVideo = item.mimeType.startsWith("video/");

  const placeholder = (
    <MediaTilePlaceholder
      caption={caption}
      reservesAction={derivative?.status === "failed" && derivative.canRetry}
    >
      {isVideo ? <Play aria-hidden /> : <FileImage aria-hidden />}
    </MediaTilePlaceholder>
  );

  // A server from before thumbnails sends no state. Its images can only show as originals.
  if (derivative === undefined) {
    return entered && !isVideo ? (
      <MediaTileImage src={item.previewUrl} fallback={placeholder} />
    ) : (
      placeholder
    );
  }

  switch (derivative.status) {
    case "ready":
      if (derivative.kind === "poster") {
        return (
          <>
            {entered ? <MediaTileImage src={derivative.url} fallback={null} /> : null}
            <MediaTileBadge>
              <Play aria-hidden />
            </MediaTileBadge>
          </>
        );
      }

      return entered ? <MediaTileImage src={derivative.url} fallback={placeholder} /> : placeholder;
    // No state but ready ever loads the original: a tile mustn't cost a full download while waiting.
    case "queued":
    case "processing":
    case "unavailable":
    case "unsupported":
    case "failed":
      return placeholder;
    default:
      derivative satisfies never;

      return placeholder;
  }
}

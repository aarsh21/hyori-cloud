import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Download, Info } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Lightbox,
  LightboxAction,
  LightboxImage,
  LightboxMessage,
  LightboxNotice,
  LightboxPending,
  LightboxVideo,
} from "@hyori-cloud/ui/components/lightbox";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { usePreloadImages } from "@hyori-cloud/ui/hooks/use-preload-images";
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useFileUrl } from "#features/files/react/use-file-url.ts";
import { describeCloudError, endsItemAccess } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Photos arrive with a ready-to-use URL. Items from a file listing request one when opened. */
type MediaItem = FileEntry & { readonly previewUrl?: string };

// The viewer always shows the full original, never a thumbnail, so speculation has to be bounded.
const PRELOAD_MAX_BYTES = 8 * 1024 * 1024;

function preloadableUrl(item: MediaItem | undefined) {
  if (item?.previewUrl === undefined) return [];

  return item.mimeType.startsWith("image/") && item.size <= PRELOAD_MAX_BYTES
    ? [item.previewUrl]
    : [];
}

/**
 * `items` are the media in view. Stepping updates only the selected ID the owner already holds. The
 * item type is left to the owner, so a screen with richer items — a timeline's thumbnails, say — can
 * offer them through `info` and `thumbnailOf` without re-listing them here.
 */
export function MediaViewer<Item extends MediaItem>({
  items,
  itemId,
  open,
  onOpenChange,
  onSelect,
  origin,
  info,
  thumbnailOf,
  notice,
  actions,
}: {
  items: readonly Item[];
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  /** The tile the viewer opened from, so the media can grow out of it. */
  origin?: DOMRect | null;
  /** Renders the details panel for the open item. Providing it adds the panel's control and key. */
  info?: (item: Item) => ReactNode;
  /** A tile's thumbnail for the open item, holding the frame while the original decodes. */
  thumbnailOf?: (item: Item) => string | null | undefined;
  /** Feedback about an action, over the stage like the download's. */
  notice?: ReactNode;
  actions?: ReactNode;
}) {
  const index = items.findIndex((item) => item.id === itemId);
  const item = items[index];
  const previous = items[index - 1];
  const next = items[index + 1];
  const download = useDownloadFile();
  const [infoOpen, setInfoOpen] = useState(false);

  usePreloadImages(open ? [...preloadableUrl(previous), ...preloadableUrl(next)] : []);

  if (item === undefined) return null;

  const placeholder =
    thumbnailOf === undefined || !item.mimeType.startsWith("image/")
      ? null
      : (thumbnailOf(item) ?? null);

  return (
    <Lightbox
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) download.reset();
        onOpenChange(nextOpen);
      }}
      title={item.name}
      subtitle={`${index + 1} of ${items.length}`}
      onPrevious={previous ? () => onSelect(previous.id) : undefined}
      onNext={next ? () => onSelect(next.id) : undefined}
      onInfoToggle={info === undefined ? undefined : () => setInfoOpen((value) => !value)}
      origin={origin}
      panel={info === undefined || !infoOpen ? undefined : info(item)}
      actions={
        <>
          {info === undefined ? null : (
            <LightboxAction
              aria-label="Details"
              aria-pressed={infoOpen}
              onClick={() => setInfoOpen((value) => !value)}
            >
              <Info aria-hidden />
            </LightboxAction>
          )}
          {actions}
          {item.access.canDownload ? (
            <LightboxAction
              aria-label={`Download ${item.name}`}
              aria-busy={download.isPending}
              disabled={download.isPending}
              onClick={() => download.mutate({ id: item.id })}
            >
              {download.isPending ? (
                <Spinner label="Preparing download" className="text-current" />
              ) : (
                <Download aria-hidden />
              )}
            </LightboxAction>
          ) : null}
        </>
      }
    >
      <MediaStage key={item.id} item={item} active={open} placeholder={placeholder} />
      {notice ?? null}
      {download.error !== null && download.variables.id === item.id ? (
        <DownloadFailure
          error={download.error}
          onRetry={() => download.mutate({ id: item.id })}
          onRecovered={() => download.reset()}
        />
      ) : null}
    </Lightbox>
  );
}

function DownloadFailure({
  error,
  onRetry,
  onRecovered,
}: {
  error: CloudError;
  onRetry: () => void;
  onRecovered: () => void;
}) {
  const recovery = useAccessRecovery(error);

  return (
    <LightboxNotice
      title={`Couldn’t download. ${(recovery ?? describeCloudError(error)).title}.`}
      action={
        recovery === null ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={onRecovered} />
        )
      }
    />
  );
}

/**
 * A photo already knows its URL, so it opens with no request of its own. If that can't be shown,
 * asking for the preview again tells apart lost access, which can be recovered, from a file this
 * browser can't decode, which can't.
 */
function MediaStage({
  item,
  active,
  placeholder,
}: {
  item: MediaItem;
  active: boolean;
  placeholder: string | null;
}) {
  const requested = <RequestedMedia item={item} active={active} />;

  if (item.previewUrl === undefined) return requested;

  return item.mimeType.startsWith("video/") ? (
    <LightboxVideo src={item.previewUrl} label={item.name} fallback={requested} />
  ) : (
    <LightboxImage
      src={item.previewUrl}
      alt={item.name}
      placeholder={placeholder}
      fallback={requested}
    />
  );
}

function RequestedMedia({ item, active }: { item: MediaItem; active: boolean }) {
  const url = useFileUrl(item.id, active);

  const unavailable = (
    <LightboxMessage
      title={
        item.access.canDownload
          ? "This can’t be previewed here. You can still download it."
          : "This can’t be previewed here."
      }
    />
  );

  // The server refuses types it won't show inline, so trying again wouldn't change the answer.
  if (url.error?.code === "input.invalid") return unavailable;

  // A URL from before access ended or the file left is no reason to keep showing it.
  if (url.error !== null && endsItemAccess(url.error)) {
    return <PreviewFailure error={url.error} onRetry={() => url.refetch()} />;
  }

  if (url.data !== undefined) {
    return item.mimeType.startsWith("video/") ? (
      <LightboxVideo src={url.data.url} label={item.name} fallback={unavailable} />
    ) : (
      <LightboxImage src={url.data.url} alt={item.name} fallback={unavailable} />
    );
  }

  if (url.error !== null) return <PreviewFailure error={url.error} onRetry={() => url.refetch()} />;

  return <LightboxPending />;
}

function PreviewFailure({ error, onRetry }: { error: CloudError; onRetry: () => void }) {
  const recovery = useAccessRecovery(error);

  return (
    <LightboxMessage
      title={(recovery ?? describeCloudError(error)).title}
      action={
        recovery === null ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : (
          <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={onRetry} />
        )
      }
    />
  );
}

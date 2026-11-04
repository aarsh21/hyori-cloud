import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Download } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
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
import { useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useFileUrl } from "#features/files/react/use-file-url.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** `items` are the media in view. Stepping updates only the selected ID the owner already holds. */
export function MediaViewer({
  items,
  itemId,
  open,
  onOpenChange,
  onSelect,
  actions,
}: {
  items: readonly FileEntry[];
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  actions?: ReactNode;
}) {
  const index = items.findIndex((item) => item.id === itemId);
  const item = items[index];
  const previous = items[index - 1];
  const next = items[index + 1];
  const download = useDownloadFile();

  if (item === undefined) return null;

  return (
    <Lightbox
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) download.reset();
        onOpenChange(nextOpen);
      }}
      title={item.name}
      onPrevious={previous ? () => onSelect(previous.id) : undefined}
      onNext={next ? () => onSelect(next.id) : undefined}
      actions={
        <>
          {actions}
          {item.access.canDownload ? (
            <LightboxAction
              aria-label={`Download ${item.name}`}
              aria-busy={download.isPending}
              disabled={download.isPending}
              onClick={() => download.mutate({ id: item.id })}
            >
              <Download aria-hidden />
            </LightboxAction>
          ) : null}
        </>
      }
    >
      <MediaStage key={item.id} item={item} active={open} />
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

function MediaStage({ item, active }: { item: FileEntry; active: boolean }) {
  const url = useFileUrl(item.id, active);
  const recovery = useAccessRecovery(url.error);

  if (url.data !== undefined) {
    const unavailable = (
      <LightboxMessage
        title={
          item.access.canDownload
            ? "This can’t be previewed here. You can still download it."
            : "This can’t be previewed here."
        }
      />
    );

    return item.mimeType.startsWith("video/") ? (
      <LightboxVideo src={url.data.url} label={item.name} fallback={unavailable} />
    ) : (
      <LightboxImage src={url.data.url} alt={item.name} fallback={unavailable} />
    );
  }

  if (url.error !== null) {
    return (
      <LightboxMessage
        title={(recovery ?? describeCloudError(url.error)).title}
        action={
          recovery === null ? (
            <Button variant="outline" size="sm" onClick={() => url.refetch()}>
              Try again
            </Button>
          ) : (
            <AccessRecoveryButton recovery={recovery} size="sm" />
          )
        }
      />
    );
  }

  return <LightboxPending />;
}

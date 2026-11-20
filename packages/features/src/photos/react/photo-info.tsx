import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { ExternalLink } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { useQuery } from "@hyori-cloud/lib/query";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import type { LibraryItem } from "#features/photos/photo-derivative.ts";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatMediaType,
} from "#features/shared/format.ts";

/**
 * The viewer's details panel. The rows come from the timeline item itself, so they're complete the
 * moment the panel opens; the capture time and location are an enrichment of exactly the item being
 * looked at, asked for only while the panel is open. Enrichment that fails leaves the day-level
 * values standing rather than replacing them with an alarm — the photo is still fully there.
 */
export function PhotoInfoPanel({ item }: { item: LibraryItem }) {
  const { query } = useClientSDK();
  const details = useQuery(query.photos.details.getOptions({ id: item.id }));

  const capture = details.data?.capture ?? null;
  const taken = item.dateSource === "capture";

  return (
    <dl className="flex flex-col gap-3.5 text-[13px]">
      <InfoRow label={taken ? "Date taken" : "Uploaded"}>
        {capture !== null
          ? formatDateTime(capture.localDateTime)
          : taken
            ? formatDate(`${item.timelineDate}T00:00:00`)
            : formatDateTime(item.createdAt)}
      </InfoRow>
      <InfoRow label="Size">{formatBytes(item.size)}</InfoRow>
      <InfoRow label="Type">{formatMediaType(item.mimeType)}</InfoRow>
      <FolderRow item={item} />
      {details.data?.location != null ? (
        <InfoRow label="Location">
          <a
            href={`https://www.openstreetmap.org/?mlat=${details.data.location.latitude}&mlon=${details.data.location.longitude}#map=16/${details.data.location.latitude}/${details.data.location.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm underline decoration-white/30 underline-offset-4 outline-none transition-colors hover:decoration-white/70 focus-visible:ring-2 focus-visible:ring-white"
          >
            {details.data.location.latitude.toFixed(4)},{" "}
            {details.data.location.longitude.toFixed(4)}
            <ExternalLink aria-hidden className="ml-1 inline size-3.5 align-[-0.125em]" />
          </a>
        </InfoRow>
      ) : null}
    </dl>
  );
}

/** The folder an item lives in, linked so the panel is also a way back to its context. */
function FolderRow({ item }: { item: LibraryItem }) {
  return item.parentId === null ? (
    <InfoRow label="Folder">
      <FolderLink name="Files" folderId={null} />
    </InfoRow>
  ) : (
    <ParentFolderRow folderId={item.parentId} />
  );
}

function ParentFolderRow({ folderId }: { folderId: string }) {
  const { query } = useClientSDK();
  const folder = useQuery(query.files.get.getOptions({ id: folderId }));

  return (
    <InfoRow label="Folder">
      {folder.data !== undefined ? (
        <FolderLink name={folder.data.name} folderId={folderId} />
      ) : folder.isError ? (
        <span className="text-white/55">Unavailable</span>
      ) : (
        <Skeleton className="h-4 w-24" />
      )}
    </InfoRow>
  );
}

function FolderLink({ name, folderId }: { name: string; folderId: string | null }) {
  const { navigatePath } = useCloudNavigation();
  const path = formatCloudPath({ section: "files", folderId });

  return (
    <a
      href={path}
      onClick={(event) => {
        event.preventDefault();
        navigatePath(path);
      }}
      className="rounded-sm underline decoration-white/30 underline-offset-4 outline-none transition-colors hover:decoration-white/70 focus-visible:ring-2 focus-visible:ring-white"
    >
      {name}
    </a>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-white/55">{label}</dt>
      <dd className="text-pretty">{children}</dd>
    </div>
  );
}

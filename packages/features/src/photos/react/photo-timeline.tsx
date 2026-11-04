import { useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { ItemNavigation } from "@hyori-cloud/ui/components/item-collection";
import { MediaGrid, MediaGridSkeleton, MediaGroup } from "@hyori-cloud/ui/components/media-grid";
import { AlbumMenu } from "#features/photos/react/album-menu.tsx";
import { PhotoTile } from "#features/photos/react/photo-tile.tsx";
import type { PhotoTimeline as PhotoTimelineResource } from "#features/photos/react/use-photos.ts";
import { groupByMonth } from "#features/photos/timeline-groups.ts";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { OfflineState } from "#features/shared/react/offline-state.tsx";
import { QueryFailure } from "#features/shared/react/query-failure.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

type ViewerState = { readonly itemId: string; readonly open: boolean };

export function PhotoTimeline({
  timeline,
  empty,
}: {
  timeline: PhotoTimelineResource;
  empty: ReactNode;
}) {
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  if (timeline.data === undefined) {
    if (timeline.error !== null) {
      return <QueryFailure error={timeline.error} onRetry={() => timeline.refetch()} />;
    }

    if (timeline.fetchStatus === "paused") return <OfflineState />;

    return <MediaGridSkeleton />;
  }

  const items = timeline.data.pages.flatMap((page) => page.items);

  if (items.length === 0) return empty;

  function openViewer(itemId: string) {
    setViewer({ itemId, open: true });
  }

  return (
    <>
      {timeline.isRefetchError ? (
        <RefreshFailure error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : null}
      <ItemNavigation itemKeys={items.map((item) => item.id)} layout="grid">
        {groupByMonth(items).map((group) => (
          <MediaGroup key={group.title} title={group.title}>
            <MediaGrid>
              {group.items.map((item) => (
                <PhotoTile
                  key={item.id}
                  item={item}
                  previewUrl={item.previewUrl}
                  onOpen={openViewer}
                />
              ))}
            </MediaGrid>
          </MediaGroup>
        ))}
      </ItemNavigation>
      <LoadMore pages={timeline} />
      {viewer === null ? null : (
        <MediaViewer
          items={items}
          itemId={viewer.itemId}
          open={viewer.open}
          onOpenChange={(open) => setViewer({ ...viewer, open })}
          onSelect={openViewer}
          actions={<AlbumMenu fileId={viewer.itemId} />}
        />
      )}
    </>
  );
}

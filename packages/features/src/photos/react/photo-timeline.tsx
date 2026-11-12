import { useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { ItemNavigation } from "@hyori-cloud/ui/components/item-collection";
import { MediaGrid, MediaGridSkeleton, MediaGroup } from "@hyori-cloud/ui/components/media-grid";
import { VirtualSections } from "@hyori-cloud/ui/components/virtual-items";
import { AlbumMenu } from "#features/photos/react/album-menu.tsx";
import { PhotoTile } from "#features/photos/react/photo-tile.tsx";
import type { PhotoTimeline as PhotoTimelineResource } from "#features/photos/react/use-photos.ts";
import { groupByMonth } from "#features/photos/timeline-groups.ts";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
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
    return <QueryWaiting resource={timeline} pending={<MediaGridSkeleton />} />;
  }

  const items = timeline.data.pages.flatMap((page) => page.items);

  if (items.length === 0) return empty;

  const groups = groupByMonth(items);

  function openViewer(itemId: string) {
    setViewer({ itemId, open: true });
  }

  return (
    <>
      {timeline.isRefetchError ? (
        <RefreshFailure error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : null}
      <ItemNavigation
        itemKeys={items.map((item) => item.id)}
        layout="grid"
        groupSizes={groups.map((group) => group.items.length)}
      >
        <VirtualSections
          // A run of one month can recur when the server's order revisits it, so titles aren't unique.
          sections={groups.map((group, index) => ({
            key: `${index}:${group.title}`,
            items: group.items,
          }))}
          itemKey={(item) => item.id}
          list={<MediaGrid />}
          renderSection={(key, content) => (
            <MediaGroup title={key.slice(key.indexOf(":") + 1)}>{content}</MediaGroup>
          )}
        >
          {(item) => <PhotoTile item={item} onOpen={openViewer} />}
        </VirtualSections>
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

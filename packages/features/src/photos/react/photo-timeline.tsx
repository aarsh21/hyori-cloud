import { normalizeClientError } from "@hyori-cloud/client-sdk";
import { Share2, Trash2 } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { DeferredDialog } from "@hyori-cloud/ui/components/deferred-dialog";
import { ItemNavigation } from "@hyori-cloud/ui/components/item-collection";
import { LightboxAction, LightboxNotice } from "@hyori-cloud/ui/components/lightbox";
import {
  MediaGrid,
  MediaGridSkeleton,
  preloadMediaTiles,
} from "@hyori-cloud/ui/components/media-grid";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { VirtualSections } from "@hyori-cloud/ui/components/virtual-items";
import { loadShareDialog } from "#features/files/react/file-dialog-loaders.ts";
import { useRestoreFile, useTrashFile } from "#features/files/react/use-file-mutations.ts";
import { MediaViewer } from "#features/media/react/media-viewer.tsx";
import { AlbumMenu } from "#features/photos/react/album-menu.tsx";
import { PhotoScrubber, type ScrubberMonth } from "#features/photos/react/photo-scrubber.tsx";
import { PhotoTile } from "#features/photos/react/photo-tile.tsx";
import type { PhotoItem } from "#features/photos/photo-derivative.ts";
import { groupTimelineByDay, type TimelineGroup } from "#features/photos/timeline-groups.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";

type ViewerState = {
  readonly itemId: string;
  readonly open: boolean;
  readonly origin: DOMRect | null;
};

const loadShare = async () => (await loadShareDialog()).ShareDialog;

/** A tile still on screen, so the viewer can fly back into it on close. */
function tileRectOf(itemId: string): DOMRect | null {
  const tile = document.querySelector(`[data-item-key="${CSS.escape(itemId)}"]`);

  // A tile virtualized away or scrolled out of sight can't anchor the flight; the close fades.
  if (!(tile instanceof HTMLElement)) return null;

  const rect = tile.getBoundingClientRect();

  if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return null;

  return rect;
}

/**
 * Cursor pages of media, whichever feed owns them: the library's or one album's. The shape is what
 * the timeline reads from such pages, so both feeds can share this view without sharing a contract.
 */
type PhotoPages<Item> = {
  readonly data?: { readonly pages: readonly { readonly items: readonly Item[] }[] };
  readonly error: CloudError | null;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  readonly isRefetchError: boolean;
  readonly refetch: () => void;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly isFetchNextPageError: boolean;
  readonly fetchNextPage: () => void;
};

/**
 * The date-grouped timeline. `dayKeyOf` names the calendar day of each item — the library's
 * `timelineDate`, or an album's fallback to its own timestamps — and day labels are formatted in
 * this browser, so hydration is awaited before the first grouped paint.
 */
export function PhotoTimeline<Item extends PhotoItem>({
  timeline,
  dayKeyOf,
  empty,
  viewerInfo,
  scrubber,
}: {
  timeline: PhotoPages<Item>;
  dayKeyOf: (item: Item) => string;
  empty: ReactNode;
  /** Extra content for the open item's details panel. Providing it adds the panel's control. */
  viewerInfo?: (item: Item) => ReactNode;
  /** Adds the month rail, for fast travel through a long timeline. */
  scrubber?: boolean;
}) {
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [share, setShare] = useState<{ readonly entry: Item; readonly open: boolean } | null>(null);
  const [trashingId, setTrashingId] = useState<string | null>(null);

  const [trashNotice, setTrashNotice] = useState<{
    readonly item: Item;
    readonly error: CloudError;
  } | null>(null);

  const trash = useTrashFile();
  const restore = useRestoreFile();
  const hydrated = useHydrated();

  // The first tiles' thumbnails start downloading now, alongside the render below rather than after
  // it. Before the hydration check, so the server's document carries the same hints.
  preloadMediaTiles(readyStills(timeline.data?.pages[0]?.items ?? []));

  // Data arrives in the document, but day labels are formatted in this browser. Keep the same
  // skeleton until hydration; warm section switches already have a client snapshot.
  if (!hydrated) return <MediaGridSkeleton />;

  if (timeline.data === undefined) {
    return <QueryWaiting resource={timeline} pending={<MediaGridSkeleton />} />;
  }

  const items = timeline.data.pages.flatMap((page) => page.items);

  if (items.length === 0) return empty;

  const groups = groupTimelineByDay(items, dayKeyOf);

  function openViewer(itemId: string, origin: DOMRect | null = null) {
    setTrashingId(null);
    setTrashNotice(null);
    setViewer({ itemId, open: true, origin });
  }

  function closeViewer() {
    setViewer((current) =>
      current === null || !current.open
        ? current
        : { ...current, open: false, origin: tileRectOf(current.itemId) },
    );
  }

  function restoreFromTrash(item: Item) {
    void restore.mutateAsync({ id: item.id }).catch((error) => {
      toast.error(`Couldn’t restore “${item.name}”`, {
        description: describeCloudError(normalizeClientError(error)).title,
        action: { label: "Try again", onClick: () => restoreFromTrash(item) },
      });
    });
  }

  function trashFromViewer(item: Item) {
    if (trashingId !== null) return;

    setTrashingId(item.id);

    void trash.mutateAsync({ id: item.id }).then(
      () => {
        toast(`Moved “${item.name}” to Trash`, {
          action: { label: "Undo", onClick: () => restoreFromTrash(item) },
        });

        // The viewer moves on to a neighbor, the same move the grid made under it.
        const index = items.findIndex((entry) => entry.id === item.id);
        const neighbor = items[index + 1] ?? items[index - 1];

        setTrashingId(null);

        if (neighbor === undefined) {
          setViewer((current) =>
            current === null ? null : { ...current, open: false, origin: null },
          );
        } else {
          setViewer({ itemId: neighbor.id, open: true, origin: null });
        }
      },
      (error) => {
        setTrashingId(null);
        setTrashNotice({ item, error: normalizeClientError(error) });
      },
    );
  }

  const monthMarks = scrubber ? timelineMonths(groups) : [];

  const viewerItem =
    viewer === null ? undefined : items.find((entry) => entry.id === viewer.itemId);

  return (
    <>
      {timeline.isRefetchError && timeline.error !== null ? (
        <RefreshFailure error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : null}
      <div className="relative">
        <ItemNavigation
          itemKeys={items.map((item) => item.id)}
          layout="grid"
          groupSizes={groups.map((group) => group.items.length)}
        >
          {timelineSections(groups, (item) => (
            <PhotoTile item={item} onOpen={openViewer} />
          ))}
        </ItemNavigation>
        {monthMarks.length > 1 ? <PhotoScrubber months={monthMarks} /> : null}
      </div>
      <LoadMore pages={timeline} />
      {viewer !== null && viewerItem !== undefined ? (
        <MediaViewer
          items={items}
          itemId={viewer.itemId}
          open={viewer.open}
          onOpenChange={() => closeViewer()}
          onSelect={(id) => openViewer(id)}
          origin={viewer.origin}
          info={viewerInfo}
          thumbnailOf={(item) =>
            item.derivative?.status === "ready" && item.derivative.kind === "thumbnail"
              ? item.derivative.url
              : null
          }
          notice={
            trashNotice !== null && trashNotice.item.id === viewer.itemId ? (
              <TrashFailure
                error={trashNotice.error}
                name={trashNotice.item.name}
                onRetry={() => trashFromViewer(trashNotice.item)}
              />
            ) : null
          }
          actions={
            <>
              {viewerItem.access.canShare ? (
                <LightboxAction
                  aria-label={`Share ${viewerItem.name}`}
                  onClick={() => setShare({ entry: viewerItem, open: true })}
                >
                  <Share2 aria-hidden />
                </LightboxAction>
              ) : null}
              <AlbumMenu fileId={viewerItem.id} />
              {viewerItem.access.canDelete ? (
                <LightboxAction
                  aria-label={`Move ${viewerItem.name} to Trash`}
                  disabled={trashingId === viewerItem.id}
                  className="text-destructive/90 hover:text-destructive"
                  onClick={() => trashFromViewer(viewerItem)}
                >
                  {trashingId === viewerItem.id ? (
                    <Spinner label="Trashing" className="text-current" />
                  ) : (
                    <Trash2 aria-hidden />
                  )}
                </LightboxAction>
              ) : null}
            </>
          }
        />
      ) : null}
      {share !== null && items.some((entry) => entry.id === share.entry.id) ? (
        <DeferredDialog
          load={loadShare}
          title="Share"
          open={share.open}
          onClose={() => setShare({ ...share, open: false })}
          props={{
            entry: share.entry,
            open: share.open,
            onOpenChange: (open: boolean) => setShare({ ...share, open }),
          }}
        />
      ) : null}
    </>
  );
}

function TrashFailure({
  error,
  name,
  onRetry,
}: {
  error: CloudError;
  name: string;
  onRetry: () => void;
}) {
  const recovery = useAccessRecovery(error);

  return (
    <LightboxNotice
      title={`Couldn’t move “${name}” to Trash. ${(recovery ?? describeCloudError(error)).title}.`}
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

/** A day's run of the timeline: the month's name when it's new, then the sticky day heading. */
function TimelineDay<Item>({
  group,
  children,
}: {
  group: TimelineGroup<Item>;
  children: ReactNode;
}) {
  return (
    <section
      data-slot="media-group"
      data-day-key={group.key}
      className="flex scroll-mt-2 flex-col gap-2 pb-4"
    >
      {group.month === null ? null : (
        <h3 className="px-1 pt-3 text-[13px] font-semibold tracking-tight">{group.month}</h3>
      )}
      <h2 className="sticky top-0 z-10 bg-card px-1 py-1.5 text-[13px] font-semibold">
        {group.label}
      </h2>
      {children}
    </section>
  );
}

/** The thumbnails and posters tiles show, in timeline order. */
function readyStills(items: readonly PhotoItem[]) {
  return items.flatMap((item) =>
    item.derivative?.status === "ready" ? [item.derivative.url] : [],
  );
}

/** The timeline's months, in its own order: each entry names where the month starts. */
function timelineMonths<Item>(groups: readonly TimelineGroup<Item>[]): ScrubberMonth[] {
  const months: ScrubberMonth[] = [];

  for (const group of groups) {
    if (group.month === null) continue;

    months.push({ key: group.key.slice(0, 7), label: group.month, dayKey: group.key });
  }

  return months;
}

function timelineSections<Item extends { readonly id: string }>(
  groups: readonly TimelineGroup<Item>[],
  render: (item: Item) => ReactNode,
) {
  // A day the server order revisits gets its own section, so keys carry the run's place in it.
  const sections = groups.map((group, index) => ({
    key: `${index}:${group.key}`,
    items: group.items,
  }));

  const dayOfSection = new Map(sections.map((section, index) => [section.key, groups[index]!]));

  return (
    <VirtualSections
      sections={sections}
      itemKey={(item) => item.id}
      list={<MediaGrid />}
      renderSection={(key, content) => {
        const group = dayOfSection.get(key);

        return group === undefined ? content : <TimelineDay group={group}>{content}</TimelineDay>;
      }}
    >
      {render}
    </VirtualSections>
  );
}

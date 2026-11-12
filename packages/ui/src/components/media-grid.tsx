"use client";

import {
  ItemKeyScope,
  useItemPositionProps,
  useItemTabIndex,
} from "@hyori-cloud/ui/components/item-collection";
import { Button } from "@hyori-cloud/ui/components/button";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { createImageLoadSlot } from "@hyori-cloud/ui/lib/image-load-slots";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

function MediaGroup({
  className,
  title,
  children,
}: {
  className?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-slot="media-group" className={cn("flex flex-col gap-2 pb-3", className)}>
      <h2 className="sticky top-0 z-10 bg-card px-1 py-1.5 text-[13px] font-medium">{title}</h2>
      {children}
    </section>
  );
}

function MediaGrid({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="media-grid"
      className={cn(
        "grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 md:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]",
        className,
      )}
      {...props}
    />
  );
}

/** Leaves room for the month heading, so the first real tile lands where its skeleton was. */
function MediaGridSkeleton({ tiles = 24 }: { tiles?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      <div className="flex h-8 items-center px-1">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 md:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]">
        {Array.from({ length: tiles }, (_, tile) => (
          <Skeleton key={tile} className="aspect-square rounded-sm" />
        ))}
      </div>
    </div>
  );
}

function MediaTileFrame({
  ref,
  itemKey,
  children,
}: {
  ref?: React.Ref<HTMLLIElement>;
  itemKey: string;
  children: React.ReactNode;
}) {
  const position = useItemPositionProps(undefined);

  return (
    <ItemKeyScope value={itemKey}>
      <li
        ref={ref}
        data-slot="media-tile"
        data-item-key={itemKey}
        className="relative [contain-intrinsic-size:auto_9.5rem] [content-visibility:auto]"
        {...position}
      >
        {children}
      </li>
    </ItemKeyScope>
  );
}

// The frame's paint containment would clip an outer ring, so focus is drawn inside the tile. The
// scroll margin keeps a tile reached by keyboard clear of the sticky month heading.
function MediaTileButton({
  className,
  label,
  onClick,
  children,
}: {
  className?: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tabIndex = useItemTabIndex();

  return (
    <button
      type="button"
      data-item-target
      tabIndex={tabIndex}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "group/tile relative block aspect-square w-full scroll-mt-10 overflow-hidden rounded-sm bg-muted outline-none active:brightness-90 fine:hover:brightness-105 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

function notGranted() {
  return false;
}

/**
 * A source that fails to load shows `fallback` rather than a permanently blank tile. Images appear
 * as they decode over the tile's resting fill: nothing animates on entrance or on scroll. Only a
 * few load at a time, and a tile that scrolls out of the rendered window gives up its turn.
 */
function MediaTileImage(props: { src: string; fallback: React.ReactNode; className?: string }) {
  // A new URL is a new image: an earlier failure says nothing about it, and it waits its own turn.
  return <TileImageLoad key={props.src} {...props} />;
}

function TileImageLoad({
  src,
  fallback,
  className,
}: {
  src: string;
  fallback: React.ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const [slot] = React.useState(createImageLoadSlot);
  const granted = React.useSyncExternalStore(slot.subscribe, slot.isGranted, notGranted);

  if (failed) return fallback;

  // Waiting its turn still shows the resting fill, but says an image is coming: without this, a
  // ready tile behind others would read the same as one with nothing to show.
  if (!granted) return <span data-slot="media-tile-image" data-state="waiting" />;

  return (
    <img
      data-slot="media-tile-image"
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      onLoad={slot.finish}
      onError={() => {
        slot.finish();
        setFailed(true);
      }}
      className={cn("size-full object-cover", className)}
    />
  );
}

function MediaTilePlaceholder({
  caption,
  reservesAction = false,
  children,
}: {
  caption?: string | null;
  /** Keeps content clear of a `MediaTileAction`, which reaches 44px on touch. */
  reservesAction?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-muted-foreground [&_svg]:size-6 [&_svg]:shrink-0 [&_svg]:stroke-[1.25]",
        reservesAction && "coarse:pb-12",
      )}
    >
      {children}
      {caption ? (
        <span
          data-slot="media-tile-caption"
          className="text-center text-[11px] leading-tight text-balance"
        >
          {caption}
        </span>
      ) : null}
    </span>
  );
}

/** Marks what a still can't show by itself, such as a poster standing in for a video. */
function MediaTileBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      data-slot="media-tile-badge"
      className="absolute bottom-1.5 left-1.5 grid size-5 place-items-center rounded-full bg-black/60 text-white [&_svg]:size-3 [&_svg]:fill-current"
    >
      {children}
    </span>
  );
}

/**
 * When a finished action goes away with focus on it, focus returns to its tile. React runs this
 * cleanup before removing the element, so it can still tell where focus is.
 */
function returnFocusToTile(button: HTMLButtonElement) {
  const tile = button.closest("[data-item-key]");

  return () => {
    if (document.activeElement === button) {
      tile?.querySelector<HTMLElement>("[data-item-target]")?.focus();
    }
  };
}

/**
 * A control beside the tile's button, not inside it, so pressing it doesn't open the item. It isn't
 * `data-item-action`: that's a row's menu, which the context-menu key opens without being asked.
 */
function MediaTileAction({
  label,
  pending,
  announcement,
  onClick,
  children,
}: {
  label: string;
  pending: boolean;
  /** Said by screen readers, since the outcome shows on a tile that doesn't hold focus. */
  announcement: string | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tabIndex = useItemTabIndex();

  return (
    <>
      <Button
        ref={returnFocusToTile}
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label={label}
        tabIndex={tabIndex}
        pending={pending}
        onClick={onClick}
        className="absolute right-1 bottom-1"
      >
        {children}
      </Button>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

export {
  MediaGrid,
  MediaGridSkeleton,
  MediaGroup,
  MediaTileAction,
  MediaTileBadge,
  MediaTileButton,
  MediaTileFrame,
  MediaTileImage,
  MediaTilePlaceholder,
};

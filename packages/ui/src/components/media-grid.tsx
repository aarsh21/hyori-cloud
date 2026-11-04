"use client";

import { ItemKeyScope, useItemTabIndex } from "@hyori-cloud/ui/components/item-collection";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
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
    <section data-slot="media-group" className={cn("flex flex-col gap-2", className)}>
      <h2 className="sticky top-0 z-10 bg-card/95 px-1 py-1.5 text-[13px] font-medium">{title}</h2>
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

function MediaGridSkeleton({ tiles = 24 }: { tiles?: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1 md:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]"
    >
      {Array.from({ length: tiles }, (_, tile) => (
        <Skeleton key={tile} className="aspect-square rounded-sm" />
      ))}
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
  return (
    <ItemKeyScope value={itemKey}>
      <li
        ref={ref}
        data-slot="media-tile"
        data-item-key={itemKey}
        className="relative [contain-intrinsic-size:auto_9.5rem] [content-visibility:auto]"
      >
        {children}
      </li>
    </ItemKeyScope>
  );
}

// The frame's paint containment would clip an outer ring, so focus is drawn inside the tile.
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
        "group/tile relative block aspect-square w-full overflow-hidden rounded-sm bg-muted outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A source that fails to load shows `fallback` rather than a permanently blank tile. */
function MediaTileImage({
  src,
  fallback,
  className,
}: {
  src: string;
  fallback: React.ReactNode;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);

  if (failedSrc === src) return fallback;

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(event) => {
        event.currentTarget.dataset.loaded = "true";
      }}
      onError={() => setFailedSrc(src)}
      className={cn(
        "size-full object-cover opacity-0 transition-opacity duration-200 data-loaded:opacity-100",
        className,
      )}
    />
  );
}

function MediaTilePlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute inset-0 grid place-items-center text-muted-foreground [&_svg]:size-6 [&_svg]:stroke-[1.25]">
      {children}
    </span>
  );
}

export {
  MediaGrid,
  MediaGridSkeleton,
  MediaGroup,
  MediaTileButton,
  MediaTileFrame,
  MediaTileImage,
  MediaTilePlaceholder,
};

"use client";

import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { useRefocusAfterRemoval } from "@hyori-cloud/ui/hooks/use-refocus-after-removal";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { adjacentInColumn } from "@hyori-cloud/ui/lib/virtual-window";
import * as React from "react";
import { flushSync } from "react-dom";

/**
 * Which item was last focused lives outside React state, so moving through a list wakes only the
 * two items whose tab stop changed instead of every row in it.
 */
function createFocusedItemStore() {
  let focusedKey: string | null = null;
  const listeners = new Set<() => void>();

  return {
    getFocusedKey: () => focusedKey,
    setFocusedKey(key: string) {
      if (key === focusedKey) return;
      focusedKey = key;

      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// `null` means no surrounding ItemNavigation: rows then keep ordinary Tab behaviour.
const FocusedItemContext = React.createContext<ReturnType<typeof createFocusedItemStore> | null>(
  null,
);

// The first item, while nothing valid has focus. Changes only when the list's head or that fact does.
const FallbackItemContext = React.createContext<string | null>(null);
const ItemKeyContext = React.createContext<string | null>(null);
const ItemKeyScope = ItemKeyContext;

export type ItemPosition = {
  readonly posInSet: number;
  readonly setSize: number;
  /** Set while the item sits outside the rendered window and is laid out by hand. */
  readonly pinned: React.CSSProperties | null;
};

const ItemPositionContext = React.createContext<ItemPosition | null>(null);
const ItemPositionScope = ItemPositionContext;

/**
 * Props for an item's root element when the collection renders only part of itself. Overscanned
 * rows must report their true height, so `content-visibility` is off here and only here.
 */
function useItemPositionProps(style: React.CSSProperties | undefined) {
  const position = React.use(ItemPositionContext);

  if (position === null) return { style };

  return {
    "aria-posinset": position.posInSet,
    "aria-setsize": position.setSize,
    style: {
      ...style,
      contentVisibility: "visible",
      ...position.pinned,
    } satisfies React.CSSProperties,
  };
}

function subscribeToNothing() {
  return () => {};
}

function serverItemKey() {
  return null;
}

function useItemTabIndex() {
  const store = React.use(FocusedItemContext);
  const fallbackKey = React.use(FallbackItemContext);
  const itemKey = React.use(ItemKeyContext);

  const isActive = React.useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    () => itemKey !== null && (fallbackKey ?? store?.getFocusedKey()) === itemKey,
    () => itemKey !== null && fallbackKey === itemKey,
  );

  if (store === null) return 0;

  return isActive ? 0 : -1;
}

/** The item holding the collection's tab stop, but only when `isShown` says it isn't on hand. */
function useItemKeyOutside(isShown: (itemKey: string) => boolean) {
  const store = React.use(FocusedItemContext);
  const fallbackKey = React.use(FallbackItemContext);

  return React.useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    () => {
      const activeKey = fallbackKey ?? store?.getFocusedKey() ?? null;

      return activeKey !== null && !isShown(activeKey) ? activeKey : null;
    },
    serverItemKey,
  );
}

function itemTarget(container: HTMLElement, itemKey: string) {
  for (const row of container.querySelectorAll<HTMLElement>("[data-item-key]")) {
    if (row.dataset.itemKey === itemKey) {
      return row.querySelector<HTMLElement>("[data-item-target]");
    }
  }

  return null;
}

function columnCount(list: Element | null) {
  if (list === null) return 1;

  const tracks = getComputedStyle(list).gridTemplateColumns;

  return tracks === "" || tracks === "none" ? 1 : tracks.trim().split(/\s+/).length;
}

/**
 * Roving-tabindex keyboard model shared by rows, tiles, and photos: one Tab stop, arrow keys move
 * immediately with no animation. Moves are worked out from the keys rather than the DOM, because the
 * next item may not be mounted yet. Portaled menu keystrokes bubble through React, so events from
 * outside the DOM subtree are ignored. `groupSizes` describes runs that each start a new grid row.
 */
function ItemNavigation({
  itemKeys,
  layout,
  groupSizes,
  onItemKeyDown,
  children,
}: {
  itemKeys: readonly string[];
  layout: "list" | "grid";
  groupSizes?: readonly number[];
  onItemKeyDown?: (itemKey: string, event: React.KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  const [store] = React.useState(createFocusedItemStore);
  const container = React.useRef<HTMLDivElement>(null);
  const { setFocusedKey } = store;

  const focusedKey = React.useSyncExternalStore(
    store.subscribe,
    store.getFocusedKey,
    serverItemKey,
  );

  useRefocusAfterRemoval(container, itemKeys, focusedKey, setFocusedKey);

  const fallbackKey =
    focusedKey !== null && itemKeys.includes(focusedKey) ? null : (itemKeys[0] ?? null);

  function moveTo(itemKey: string | undefined) {
    const element = container.current;

    if (itemKey === undefined || element === null) return;

    // An item outside the rendered window mounts first; focusing it then scrolls it into view.
    if (itemTarget(element, itemKey) === null) flushSync(() => setFocusedKey(itemKey));

    itemTarget(element, itemKey)?.focus();
  }

  return (
    <FocusedItemContext value={store}>
      <FallbackItemContext value={fallbackKey}>
        <div
          ref={container}
          role="none"
          data-slot="item-navigation"
          onFocus={(event) => {
            const key = event.target.closest<HTMLElement>("[data-item-key]")?.dataset.itemKey;

            if (key !== undefined) setFocusedKey(key);
          }}
          onKeyDown={(event) => {
            const element = event.target;

            if (!(element instanceof Element) || !event.currentTarget.contains(element)) return;

            if (event.defaultPrevented) return;

            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const row = element.closest<HTMLElement>("[data-item-key]");
            const key = row?.dataset.itemKey;

            if (!row || key === undefined) return;

            const primary = row.querySelector<HTMLElement>("[data-item-target]");
            const action = row.querySelector<HTMLElement>("[data-item-action]");
            const index = itemKeys.indexOf(key);

            const vertical = (direction: 1 | -1) => {
              const adjacent = adjacentInColumn(
                groupSizes ?? [itemKeys.length],
                layout === "grid" ? columnCount(row.parentElement) : 1,
                index,
                direction,
              );

              moveTo(adjacent === undefined ? undefined : itemKeys[adjacent]);
            };

            switch (event.key) {
              case "ArrowDown":
                vertical(1);
                break;
              case "ArrowUp":
                vertical(-1);
                break;
              case "ArrowRight":
                if (layout === "grid") moveTo(itemKeys[index + 1]);
                else action?.focus();
                break;
              case "ArrowLeft":
                if (layout === "grid") moveTo(itemKeys[index - 1]);
                else primary?.focus();
                break;
              case "Home":
                moveTo(itemKeys[0]);
                break;
              case "End":
                moveTo(itemKeys.at(-1));
                break;
              case "ContextMenu":
                action?.click();
                event.preventDefault();

                return;
              case "F10":
                if (event.shiftKey) {
                  action?.click();
                  event.preventDefault();
                }

                return;
              default:
                onItemKeyDown?.(key, event);

                return;
            }

            event.preventDefault();
          }}
        >
          {children}
        </div>
      </FallbackItemContext>
    </FocusedItemContext>
  );
}

/**
 * Rows are a list, not a `<table>`: table rows can't take `content-visibility`, which is what keeps
 * long listings cheap to lay out. Column labels are visual only, since each row's values read
 * naturally in order and narrow layouts carry the same facts as a single line.
 */
function ItemTable({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className="@container">
      <div
        data-slot="item-table"
        className={
          className ??
          "[--item-columns:minmax(0,1fr)_2.25rem] @2xl:[--item-columns:minmax(0,1fr)_10rem_6rem_2.25rem]"
        }
      >
        {children}
      </div>
    </div>
  );
}

function ItemTableHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn(
        "sticky top-0 z-10 hidden h-8 grid-cols-(--item-columns) items-center gap-3 bg-card px-2 text-xs text-muted-foreground @2xl:grid",
        className,
      )}
      {...props}
    />
  );
}

function ItemTableHeaderCell({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("truncate font-normal", className)} {...props} />;
}

function ItemTableBody({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col", className)} {...props} />;
}

function ItemTableRow({
  className,
  itemKey,
  style,
  children,
  ...props
}: React.ComponentProps<"li"> & { itemKey: string }) {
  const position = useItemPositionProps(style);

  return (
    <ItemKeyContext value={itemKey}>
      <li
        data-slot="item-table-row"
        data-item-key={itemKey}
        className={cn(
          "group/item relative grid min-h-11 grid-cols-(--item-columns) items-center gap-3 rounded-md px-2 [&_[data-item-target]]:after:absolute [&_[data-item-target]]:after:inset-0 [contain-intrinsic-size:auto_2.75rem] [content-visibility:auto] focus-within:bg-accent hover:bg-accent active:bg-accent has-aria-expanded:bg-accent @2xl:min-h-10 @2xl:[contain-intrinsic-size:auto_2.5rem] coarse:min-h-13 coarse:[contain-intrinsic-size:auto_3.25rem]",
          className,
        )}
        {...props}
        {...position}
      >
        {children}
      </li>
    </ItemKeyContext>
  );
}

function ItemTableCell({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-w-0 truncate", className)} {...props} />;
}

/** A column that only exists when there is room; narrow layouts carry the same facts as `meta`. */
function ItemTableDetailCell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "hidden min-w-0 truncate text-[13px] text-muted-foreground tabular-nums @2xl:block",
        className,
      )}
      {...props}
    />
  );
}

function ItemName({
  className,
  icon,
  meta,
  children,
}: {
  className?: string;
  icon: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", className)}>
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-[18px] [&_svg]:stroke-[1.5]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col py-1">
        <span className="truncate text-sm text-foreground">{children}</span>
        {meta === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground tabular-nums @2xl:hidden">
            {meta}
          </span>
        )}
      </span>
    </span>
  );
}

// The scroll margin keeps a row reached by keyboard clear of the sticky column labels. The focus ring
// is drawn on the overlay that spans the whole row, because the name's cell clips anything it holds.
const itemTargetClasses =
  "flex min-w-0 flex-1 scroll-mt-9 text-left outline-none after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset";

function ItemLink({ className, ...props }: React.ComponentProps<typeof AppLink>) {
  const tabIndex = useItemTabIndex();

  return (
    <AppLink
      data-item-target
      tabIndex={tabIndex}
      className={cn(itemTargetClasses, className)}
      {...props}
    />
  );
}

function ItemButton({ className, ...props }: React.ComponentProps<"button">) {
  const tabIndex = useItemTabIndex();

  return (
    <button
      type="button"
      data-item-target
      tabIndex={tabIndex}
      className={cn(itemTargetClasses, "cursor-default", className)}
      {...props}
    />
  );
}

/**
 * Secondary row control. Hidden until hover or focus on fine pointers, always visible on touch
 * where hover does not exist. The reveals are stacked on `fine:` because Tailwind sorts a plain
 * media variant after `group-hover`, which would let the hidden state win over them.
 */
function ItemActionSlot({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative z-10 flex justify-end fine:opacity-0 fine:group-focus-within/item:opacity-100 fine:group-hover/item:opacity-100 fine:has-aria-expanded:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Holds the real table's geometry at each width, so rows arriving move nothing around them. */
function ItemTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden data-slot="item-table-skeleton" className="@container">
      <div className="flex flex-col @2xl:pt-8">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="flex min-h-11 items-center gap-2.5 px-2 @2xl:min-h-10 coarse:min-h-13"
          >
            <Skeleton className="size-[18px] shrink-0 rounded-[5px]" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3" style={{ width: `${28 + ((row * 37) % 34)}%` }} />
              <Skeleton className="h-2.5 w-24 @2xl:hidden" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemGrid({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="item-grid"
      className={cn(
        "grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 px-0.5",
        className,
      )}
      {...props}
    />
  );
}

function ItemTile({
  className,
  itemKey,
  preview,
  action,
  style,
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  itemKey: string;
  preview: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const position = useItemPositionProps(style);

  return (
    <ItemKeyContext value={itemKey}>
      <li
        data-slot="item-tile"
        data-item-key={itemKey}
        className={cn(
          "group/item relative flex flex-col gap-1.5 rounded-lg p-1.5 [&_[data-item-target]]:after:absolute [&_[data-item-target]]:after:inset-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto] focus-within:bg-accent hover:bg-accent active:bg-accent has-aria-expanded:bg-accent",
          className,
        )}
        {...props}
        {...position}
      >
        <div className="grid aspect-[4/3] place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-8 [&_svg]:stroke-[1.25]">
          {preview}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {children}
          {action === undefined ? null : <ItemActionSlot>{action}</ItemActionSlot>}
        </div>
      </li>
    </ItemKeyContext>
  );
}

function ItemTileLabel({ children, meta }: { children: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col px-1 py-0.5">
      <span className="truncate text-sm text-foreground">{children}</span>
      {meta === undefined ? null : (
        <span className="truncate text-xs text-muted-foreground tabular-nums">{meta}</span>
      )}
    </span>
  );
}

function ItemGridSkeleton({ tiles = 12 }: { tiles?: number }) {
  return (
    <div
      aria-hidden
      className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 px-0.5"
    >
      {Array.from({ length: tiles }, (_, tile) => (
        <div key={tile} className="flex flex-col gap-1.5 p-1.5">
          <Skeleton className="aspect-[4/3] rounded-md" />
          <div className="flex h-10 flex-col justify-center gap-1.5 px-1">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

export {
  ItemActionSlot,
  ItemButton,
  ItemGrid,
  ItemGridSkeleton,
  ItemLink,
  ItemName,
  ItemNavigation,
  ItemTable,
  ItemTableBody,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableRow,
  ItemTableSkeleton,
  ItemTile,
  ItemTileLabel,
  ItemKeyScope,
  ItemPositionScope,
  useItemKeyOutside,
  useItemPositionProps,
  useItemTabIndex,
};

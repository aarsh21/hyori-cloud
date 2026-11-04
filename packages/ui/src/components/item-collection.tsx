"use client";

import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { useRefocusAfterRemoval } from "@hyori-cloud/ui/hooks/use-refocus-after-removal";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

// `undefined` means no surrounding ItemNavigation: rows then keep ordinary Tab behaviour.
const ActiveItemContext = React.createContext<string | null | undefined>(undefined);
const ItemKeyContext = React.createContext<string | null>(null);
const ItemKeyScope = ItemKeyContext;

function useItemTabIndex() {
  const activeKey = React.use(ActiveItemContext);
  const itemKey = React.use(ItemKeyContext);

  if (activeKey === undefined) return 0;

  return itemKey !== null && activeKey === itemKey ? 0 : -1;
}

function sameColumnTarget(targets: HTMLElement[], index: number, direction: 1 | -1) {
  const left = targets[index]?.getBoundingClientRect().left;

  if (left === undefined) return undefined;

  for (let next = index + direction; next >= 0 && next < targets.length; next += direction) {
    if (Math.abs((targets[next]?.getBoundingClientRect().left ?? Infinity) - left) < 2) {
      return targets[next];
    }
  }

  return undefined;
}

/**
 * Roving-tabindex keyboard model shared by rows, tiles, and photos: one Tab stop, arrow keys move
 * immediately with no animation. Portaled menu keystrokes bubble through React, so events from
 * outside the DOM subtree are ignored.
 */
function ItemNavigation({
  itemKeys,
  layout,
  onItemKeyDown,
  children,
}: {
  itemKeys: readonly string[];
  layout: "list" | "grid";
  onItemKeyDown?: (itemKey: string, event: React.KeyboardEvent) => void;
  children: React.ReactNode;
}) {
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const container = React.useRef<HTMLDivElement>(null);

  useRefocusAfterRemoval(container, itemKeys, focusedKey);

  const activeKey =
    focusedKey !== null && itemKeys.includes(focusedKey) ? focusedKey : (itemKeys[0] ?? null);

  return (
    <ActiveItemContext value={activeKey}>
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

          const targets = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("[data-item-target]"),
          );

          const primary = row.querySelector<HTMLElement>("[data-item-target]");
          const action = row.querySelector<HTMLElement>("[data-item-action]");
          const index = primary ? targets.indexOf(primary) : -1;
          let next: HTMLElement | null | undefined;

          switch (event.key) {
            case "ArrowDown":
              next = sameColumnTarget(targets, index, 1);
              break;
            case "ArrowUp":
              next = sameColumnTarget(targets, index, -1);
              break;
            case "ArrowRight":
              next = layout === "grid" ? targets[index + 1] : action;
              break;
            case "ArrowLeft":
              next = layout === "grid" ? targets[index - 1] : primary;
              break;
            case "Home":
              next = targets[0];
              break;
            case "End":
              next = targets.at(-1);
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
          next?.focus();
        }}
      >
        {children}
      </div>
    </ActiveItemContext>
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
        "hidden h-8 grid-cols-(--item-columns) items-center gap-3 px-2 text-xs text-muted-foreground @2xl:grid",
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
  children,
  ...props
}: React.ComponentProps<"li"> & { itemKey: string }) {
  return (
    <ItemKeyContext value={itemKey}>
      <li
        data-slot="item-table-row"
        data-item-key={itemKey}
        className={cn(
          "group/item relative grid min-h-10 grid-cols-(--item-columns) items-center gap-3 rounded-md px-2 [&_[data-item-target]]:after:absolute [&_[data-item-target]]:after:inset-0 [contain-intrinsic-size:auto_2.5rem] [content-visibility:auto] focus-within:bg-accent hover:bg-accent has-aria-expanded:bg-accent coarse:min-h-13",
          className,
        )}
        {...props}
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
        <span className="truncate text-[13px] text-foreground">{children}</span>
        {meta === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground tabular-nums @2xl:hidden">
            {meta}
          </span>
        )}
      </span>
    </span>
  );
}

const itemTargetClasses =
  "flex min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-accent";

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
 * Secondary row control. Hidden until hover or focus on pointer devices, always visible on touch
 * where hover does not exist. `render` targets the menu trigger so it joins the roving model.
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
        "relative z-10 flex justify-end opacity-100 group-focus-within/item:opacity-100 group-hover/item:opacity-100 has-aria-expanded:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ItemTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div
      aria-hidden
      data-slot="item-table-skeleton"
      className="flex flex-col pt-8 [--item-columns:minmax(0,1fr)]"
    >
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex min-h-10 items-center gap-2.5 px-2 coarse:min-h-13">
          <Skeleton className="size-[18px] shrink-0 rounded-[5px]" />
          <Skeleton className="h-3" style={{ width: `${28 + ((row * 37) % 34)}%` }} />
        </div>
      ))}
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
  children,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  itemKey: string;
  preview: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <ItemKeyContext value={itemKey}>
      <li
        data-slot="item-tile"
        data-item-key={itemKey}
        className={cn(
          "group/item relative flex flex-col gap-1.5 rounded-lg p-1.5 [&_[data-item-target]]:after:absolute [&_[data-item-target]]:after:inset-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto] focus-within:bg-accent hover:bg-accent has-aria-expanded:bg-accent",
          className,
        )}
        {...props}
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
      <span className="truncate text-[13px] text-foreground">{children}</span>
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
          <Skeleton className="mx-1 my-1.5 h-3 w-2/3" />
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
  useItemTabIndex,
};

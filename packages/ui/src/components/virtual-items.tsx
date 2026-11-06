"use client";

import { useRender } from "@base-ui/react/use-render";
import { ItemPositionScope, useItemKeyOutside } from "@hyori-cloud/ui/components/item-collection";
import type { ItemPosition } from "@hyori-cloud/ui/components/item-collection";
import { useVirtualWindows } from "@hyori-cloud/ui/hooks/use-virtual-windows";
import { pinnedPlacement, VIRTUALIZE_ABOVE_ITEMS } from "@hyori-cloud/ui/lib/virtual-window";
import type { ItemGridMetrics, ItemWindow } from "@hyori-cloud/ui/lib/virtual-window";
import * as React from "react";

type VirtualSection<Item> = { readonly key: string; readonly items: readonly Item[] };

type ListElement = React.ReactElement<React.ComponentProps<"ul">>;

/** One component type at every size, so a list crossing the threshold keeps its rows and focus. */
function VirtualSlot<Item>({
  item,
  index,
  setSize,
  windowed,
  pinned,
  render,
}: {
  item: Item;
  index: number;
  setSize: number;
  windowed: boolean;
  pinned: React.CSSProperties | null;
  render: (item: Item) => React.ReactNode;
}) {
  const position: ItemPosition | null = windowed ? { posInSet: index + 1, setSize, pinned } : null;

  return <ItemPositionScope value={position}>{render(item)}</ItemPositionScope>;
}

function VirtualList<Item>({
  items,
  itemKey,
  list,
  listRef,
  range,
  windowed,
  metrics,
  pinnedIndex,
  render,
}: {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  list: ListElement;
  listRef: (element: HTMLElement | null) => void;
  range: ItemWindow;
  windowed: boolean;
  metrics: ItemGridMetrics | null;
  pinnedIndex: number | null;
  render: (item: Item) => React.ReactNode;
}) {
  const shown: number[] = [];

  // Document order is kept, so a pinned item entering the window is never moved, which would blur it.
  if (pinnedIndex !== null && pinnedIndex < range.start) shown.push(pinnedIndex);

  for (let index = range.start; index < range.end; index += 1) shown.push(index);

  if (pinnedIndex !== null && pinnedIndex >= range.end) shown.push(pinnedIndex);

  const children = shown.map((index) => {
    const item = items[index];

    if (item === undefined) return null;

    return (
      <VirtualSlot
        key={itemKey(item)}
        item={item}
        index={index}
        setSize={items.length}
        windowed={windowed}
        pinned={index === pinnedIndex && metrics !== null ? pinnedPlacement(index, metrics) : null}
        render={render}
      />
    );
  });

  return useRender({
    render: list,
    ref: listRef,
    props: {
      children,
      style: windowed
        ? {
            paddingTop: range.paddingTop,
            paddingBottom: range.paddingBottom,
            position: "relative",
            overflowAnchor: "none",
          }
        : undefined,
    },
  });
}

/**
 * Keeps long collections to the items near the screen, across one or more lists that scroll
 * together. Each list keeps its full height, and the item holding the collection's tab stop stays
 * mounted at its real position wherever the window is, so focus survives scrolling. Small
 * collections render whole, which keeps find-in-page and printing working for them.
 */
function VirtualSections<Item>({
  sections,
  itemKey,
  list,
  renderSection,
  children,
}: {
  sections: readonly VirtualSection<Item>[];
  itemKey: (item: Item) => string;
  list: ListElement;
  renderSection?: (key: string, content: React.ReactNode) => React.ReactNode;
  children: (item: Item) => React.ReactNode;
}) {
  const counts = sections.map((section) => section.items.length);

  const { windows, windowed, metrics, registerList } = useVirtualWindows(
    counts,
    counts.reduce((sum, count) => sum + count, 0) > VIRTUALIZE_ABOVE_ITEMS,
  );

  const locations = React.useMemo(() => {
    const found = new Map<string, { readonly section: number; readonly index: number }>();

    if (windowed) {
      for (const [section, { items }] of sections.entries()) {
        for (const [index, item] of items.entries()) found.set(itemKey(item), { section, index });
      }
    }

    return found;
  }, [sections, itemKey, windowed]);

  const pinnedKey = useItemKeyOutside((key) => {
    const location = locations.get(key);

    if (location === undefined) return true;

    const range = windows[location.section];

    return range !== undefined && location.index >= range.start && location.index < range.end;
  });

  const pinned = pinnedKey === null ? undefined : locations.get(pinnedKey);

  return sections.map((section, sectionIndex) => {
    const range = windows[sectionIndex];

    if (range === undefined) return null;

    const content = (
      <VirtualList
        items={section.items}
        itemKey={itemKey}
        list={list}
        listRef={registerList(sectionIndex)}
        range={range}
        windowed={windowed}
        metrics={metrics}
        pinnedIndex={pinned?.section === sectionIndex ? pinned.index : null}
        render={children}
      />
    );

    return (
      <React.Fragment key={section.key}>
        {renderSection === undefined ? content : renderSection(section.key, content)}
      </React.Fragment>
    );
  });
}

/** A single list. Its items are ordinary children of `list`, whichever list or grid that is. */
function VirtualItems<Item>({
  items,
  itemKey,
  list,
  children,
}: {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  list: ListElement;
  children: (item: Item) => React.ReactNode;
}) {
  return (
    <VirtualSections sections={[{ key: "items", items }]} itemKey={itemKey} list={list}>
      {children}
    </VirtualSections>
  );
}

export { VirtualItems, VirtualSections };

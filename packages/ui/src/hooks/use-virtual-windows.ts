import {
  initialWindows,
  itemWindow,
  visibleRows,
  wholeWindow,
} from "@hyori-cloud/ui/lib/virtual-window";
import type { ItemGridMetrics, ItemWindow, RowWindow } from "@hyori-cloud/ui/lib/virtual-window";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

type MeasuredLayout = {
  readonly metrics: ItemGridMetrics;
  readonly rows: readonly RowWindow[];
};

function scrollParentOf(element: HTMLElement) {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);

    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }

  return null;
}

function pixels(value: string) {
  return Number.parseFloat(value) || 0;
}

function measureMetrics(list: HTMLElement): ItemGridMetrics | null {
  const item = list.firstElementChild;
  const height = item?.getBoundingClientRect().height ?? 0;

  if (height <= 0) return null;

  const style = getComputedStyle(list);
  const tracks = style.display === "grid" ? style.gridTemplateColumns.trim().split(/\s+/) : [];
  const columnWidth = tracks.length > 1 ? pixels(tracks[0] ?? "") : null;
  const rowGap = pixels(style.rowGap);

  return {
    rowStride: height + rowGap,
    rowGap,
    columns: Math.max(tracks.length, 1),
    columnStride: (columnWidth ?? 0) + pixels(style.columnGap),
    columnWidth,
    insetLeft: pixels(style.paddingLeft),
  };
}

function sameRows(previous: readonly RowWindow[], next: readonly RowWindow[]) {
  return (
    previous.length === next.length &&
    previous.every(
      (rows, index) => rows.first === next[index]?.first && rows.last === next[index]?.last,
    )
  );
}

function sameMetrics(previous: ItemGridMetrics, next: ItemGridMetrics) {
  return (
    previous.rowStride === next.rowStride &&
    previous.columns === next.columns &&
    previous.columnStride === next.columnStride &&
    previous.insetLeft === next.insetLeft
  );
}

/**
 * Host adapter. Which items are near the screen depends on scroll position and layout, which only
 * the DOM knows. Owns one scroll listener and one ResizeObserver per collection. Measures before
 * paint, then coalesces updates to a frame. Without a scroll parent or a measurable layout there is
 * nothing to bound against, so every item stays mounted. Registered as a host adapter.
 */
export function useVirtualWindows(counts: readonly number[], enabled: boolean) {
  const lists = useRef(new Map<number, HTMLElement>());
  const metrics = useRef<ItemGridMetrics | null>(null);
  const [layout, setLayout] = useState<MeasuredLayout | "unmeasurable" | null>(null);
  // A list that grows past the threshold keeps its rows until measured: dropping them first would
  // shrink the page and clamp the scroll position of someone reading at the bottom.
  const [everWhole, setEverWhole] = useState(!enabled);

  if (!enabled && !everWhole) setEverWhole(true);

  const update = useEffectEvent((remeasure: boolean) => {
    const elements = [...lists.current.values()];
    const scroller = elements[0] === undefined ? null : scrollParentOf(elements[0]);

    if (scroller === null) {
      setLayout("unmeasurable");

      return;
    }

    const populated = elements.find((list) => list.firstElementChild !== null);

    if (remeasure && populated !== undefined) {
      const measured = measureMetrics(populated);

      if (measured === null) {
        setLayout("unmeasurable");

        return;
      }

      metrics.current = measured;
    }

    const current = metrics.current;

    if (current === null) return;

    const viewport = scroller.getBoundingClientRect();

    const rows = counts.map((count, section) => {
      const list = lists.current.get(section);

      if (list === undefined) return { first: 0, last: 0 };

      return visibleRows(
        count,
        current,
        viewport.top - list.getBoundingClientRect().top,
        viewport.height,
      );
    });

    setLayout((previous) =>
      previous !== null &&
      previous !== "unmeasurable" &&
      sameRows(previous.rows, rows) &&
      sameMetrics(previous.metrics, current)
        ? previous
        : { metrics: current, rows },
    );
  });

  const countsKey = counts.join();

  // Runs for each list change, in the layout phase, so a new window is in place before it's seen.
  useLayoutEffect(() => {
    if (enabled) update(true);
  }, [enabled, countsKey]);

  useEffect(() => {
    if (!enabled) return undefined;

    const first = lists.current.values().next().value;
    const scroller = first === undefined ? null : scrollParentOf(first);

    if (scroller === null) return undefined;

    let scrollFrame = 0;
    let resizeFrame = 0;

    function onScroll() {
      scrollFrame ||= requestAnimationFrame(() => {
        scrollFrame = 0;
        update(false);
      });
    }

    const resizes = new ResizeObserver(() => {
      resizeFrame ||= requestAnimationFrame(() => {
        resizeFrame = 0;
        update(true);
      });
    });

    scroller.addEventListener("scroll", onScroll, { passive: true });
    // Columns and row height follow the width, which only ever changes along with the scroller's.
    resizes.observe(scroller);

    return () => {
      cancelAnimationFrame(scrollFrame);
      cancelAnimationFrame(resizeFrame);
      scroller.removeEventListener("scroll", onScroll);
      resizes.disconnect();
    };
  }, [enabled]);

  function registerList(section: number) {
    return (element: HTMLElement | null) => {
      if (element === null) lists.current.delete(section);
      else lists.current.set(section, element);
    };
  }

  const windowed = enabled && layout !== "unmeasurable";

  function currentWindows(): readonly ItemWindow[] {
    if (!windowed) return counts.map(wholeWindow);

    if (layout !== null) {
      return counts.map((count, section) =>
        itemWindow(count, layout.metrics, layout.rows[section] ?? { first: 0, last: 0 }),
      );
    }

    return everWhole ? counts.map(wholeWindow) : initialWindows(counts);
  }

  const windows = currentWindows();

  return {
    windows,
    windowed,
    metrics: windowed && layout !== null ? layout.metrics : null,
    registerList,
  };
}

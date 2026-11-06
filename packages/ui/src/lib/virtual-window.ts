/** Below this, every item stays in the DOM: find-in-page, printing, and screen-reader browsing just work. */
export const VIRTUALIZE_ABOVE_ITEMS = 200;

/** Rendered once before layout can be measured, and never again for that list. */
const INITIAL_WINDOW_ITEMS = 60;

const OVERSCAN_PX = 480;

// Windows move in steps of a few rows, so most scroll frames change nothing and render nothing.
const ROW_STEP = 4;

export type ItemGridMetrics = {
  /** Row height plus the gap below it. Items in one collection share a height. */
  readonly rowStride: number;
  readonly rowGap: number;
  readonly columns: number;
  readonly columnStride: number;
  /** Null for a single column that fills the list's width. */
  readonly columnWidth: number | null;
  readonly insetLeft: number;
};

export type RowWindow = { readonly first: number; readonly last: number };

export type ItemWindow = {
  readonly start: number;
  readonly end: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
};

export function wholeWindow(count: number): ItemWindow {
  return { start: 0, end: count, paddingTop: 0, paddingBottom: 0 };
}

/** What a long collection mounts before anything can be measured, split across its sections. */
export function initialWindows(counts: readonly number[]): readonly ItemWindow[] {
  let remaining = INITIAL_WINDOW_ITEMS;

  return counts.map((count) => {
    const end = Math.min(count, remaining);

    remaining -= end;

    return wholeWindow(end);
  });
}

function rowCount(count: number, columns: number) {
  return Math.ceil(count / columns);
}

function clampRow(row: number, rows: number) {
  return Math.min(Math.max(row, 0), rows);
}

/** `scrolled` is how far the list's top has passed the viewport's top; negative when still below it. */
export function visibleRows(
  count: number,
  metrics: ItemGridMetrics,
  scrolled: number,
  viewportHeight: number,
): RowWindow {
  const rows = rowCount(count, metrics.columns);
  const first = clampRow(Math.floor((scrolled - OVERSCAN_PX) / metrics.rowStride), rows);

  const last = clampRow(
    Math.ceil((scrolled + viewportHeight + OVERSCAN_PX) / metrics.rowStride),
    rows,
  );

  if (first >= last) return { first: 0, last: 0 };

  return {
    first: Math.floor(first / ROW_STEP) * ROW_STEP,
    last: Math.min(Math.ceil(last / ROW_STEP) * ROW_STEP, rows),
  };
}

/** The padding keeps the list its full height, so the scrollbar and everything below hold still. */
export function itemWindow(
  count: number,
  metrics: ItemGridMetrics,
  rowsInView: RowWindow,
): ItemWindow {
  const rows = rowCount(count, metrics.columns);
  const first = clampRow(rowsInView.first, rows);
  const last = clampRow(rowsInView.last, rows);

  if (first >= last) {
    return {
      start: 0,
      end: 0,
      paddingTop: Math.max(rows * metrics.rowStride - metrics.rowGap, 0),
      paddingBottom: 0,
    };
  }

  return {
    start: first * metrics.columns,
    end: Math.min(last * metrics.columns, count),
    paddingTop: first * metrics.rowStride,
    paddingBottom: (rows - last) * metrics.rowStride,
  };
}

/** Where an item belongs in its list, for keeping one mounted while it's outside the window. */
export function pinnedPlacement(index: number, metrics: ItemGridMetrics) {
  const top = Math.floor(index / metrics.columns) * metrics.rowStride;

  if (metrics.columnWidth === null)
    return { position: "absolute", top, left: 0, right: 0 } as const;

  return {
    position: "absolute",
    top,
    left: metrics.insetLeft + (index % metrics.columns) * metrics.columnStride,
    width: metrics.columnWidth,
  } as const;
}

/**
 * The next item straight above or below, across groups that each start a new row. A group too short
 * to reach that column is skipped, so the keyboard never drifts sideways.
 */
export function adjacentInColumn(
  groupSizes: readonly number[],
  columns: number,
  index: number,
  direction: 1 | -1,
): number | undefined {
  let group = 0;
  let groupStart = 0;

  while (index >= groupStart + (groupSizes[group] ?? Infinity)) {
    groupStart += groupSizes[group] ?? 0;
    group += 1;
  }

  const size = groupSizes[group];

  if (size === undefined) return undefined;

  const inGroup = index - groupStart;
  const sameGroup = inGroup + direction * columns;

  if (sameGroup >= 0 && sameGroup < size) return groupStart + sameGroup;

  const column = inGroup % columns;
  let start = groupStart;

  if (direction === 1) start += size;

  for (let next = group + direction; next >= 0 && next < groupSizes.length; next += direction) {
    const nextSize = groupSizes[next] ?? 0;

    if (direction === -1) start -= nextSize;

    const lastRow = rowCount(nextSize, columns) - 1;
    const row = direction === 1 ? 0 : lastRow;
    const candidate = row * columns + column;

    if (candidate < nextSize) return start + candidate;

    if (direction === -1 && lastRow > 0) return start + candidate - columns;

    if (direction === 1) start += nextSize;
  }

  return undefined;
}

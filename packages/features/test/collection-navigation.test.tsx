import { afterEach, describe, expect } from "bun:test";
import {
  ItemButton,
  ItemNavigation,
  ItemTableBody,
  ItemTableRow,
  useItemTabIndex,
} from "@hyori-cloud/ui/components/item-collection";
import { VirtualItems, VirtualSections } from "@hyori-cloud/ui/components/virtual-items";
import { adjacentInColumn, itemWindow, visibleRows } from "@hyori-cloud/ui/lib/virtual-window";
import type { ItemGridMetrics } from "@hyori-cloud/ui/lib/virtual-window";
import {
  act,
  createFakeApi,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 400;

const LIST_METRICS: ItemGridMetrics = {
  rowStride: ROW_HEIGHT,
  rowGap: 0,
  columns: 1,
  columnStride: 0,
  columnWidth: null,
  insetLeft: 0,
};

const originalRect = Element.prototype.getBoundingClientRect;

function box(top: number, height: number) {
  return new DOMRect(0, top, 800, height);
}

/** Nothing has a layout here, so this gives rows, lists, and the scroller the geometry they'd have. */
function stubLayout() {
  Element.prototype.getBoundingClientRect = function rect(this: Element) {
    if (this.tagName === "LI") return box(0, ROW_HEIGHT);

    if (this.tagName === "UL") {
      const scroller = this.closest<HTMLElement>("[data-testid='scroller']");

      return box(-(scroller?.scrollTop ?? 0), 0);
    }

    if (this.getAttribute("data-testid") === "scroller") return box(0, VIEWPORT_HEIGHT);

    return originalRect.call(this);
  };
}

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});

function keysOf(count: number) {
  return Array.from({ length: count }, (_, index) => `item-${index}`);
}

function Row({ id }: { id: string }) {
  return (
    <ItemTableRow itemKey={id}>
      <ItemButton>{id}</ItemButton>
    </ItemTableRow>
  );
}

function LongList({ keys }: { keys: readonly string[] }) {
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <ItemNavigation itemKeys={keys} layout="list">
        <VirtualItems
          items={keys}
          itemKey={(key) => key}
          list={<ItemTableBody aria-label="Long list" />}
        >
          {(key) => <Row id={key} />}
        </VirtualItems>
      </ItemNavigation>
    </div>
  );
}

function renderedRows() {
  return screen.getAllByRole("listitem");
}

function scrollTo(top: number) {
  const scroller = screen.getByTestId("scroller");

  scroller.scrollTop = top;
  fireEvent.scroll(scroller);
}

describe("window arithmetic", () => {
  test("a list keeps its full height whichever rows are mounted", () => {
    const rows = visibleRows(1000, LIST_METRICS, 8000, VIEWPORT_HEIGHT);
    const range = itemWindow(1000, LIST_METRICS, rows);
    const mounted = (range.end - range.start) * ROW_HEIGHT;

    expect(range.paddingTop + mounted + range.paddingBottom).toBe(1000 * ROW_HEIGHT);
    expect(range.end - range.start).toBeLessThan(50);
    expect(range.start * ROW_HEIGHT).toBeLessThanOrEqual(8000);
    expect(range.end * ROW_HEIGHT).toBeGreaterThanOrEqual(8000 + VIEWPORT_HEIGHT);
  });

  test("an offscreen section mounts nothing and still holds its height, gaps included", () => {
    const metrics = { ...LIST_METRICS, columns: 3, rowStride: 104, rowGap: 4 };
    const range = itemWindow(10, metrics, visibleRows(10, metrics, -5000, VIEWPORT_HEIGHT));

    expect(range.end - range.start).toBe(0);
    expect(range.paddingTop).toBe(4 * 104 - 4);
  });

  test("small scrolls land in the same window, so most frames render nothing", () => {
    const first = visibleRows(1000, LIST_METRICS, 8000, VIEWPORT_HEIGHT);

    expect(visibleRows(1000, LIST_METRICS, 8010, VIEWPORT_HEIGHT)).toEqual(first);
  });

  test("moving vertically keeps the column across groups, skipping any too short to reach it", () => {
    // 3 columns. Group sizes: 5, 1, 4.
    const groups = [5, 1, 4];

    expect(adjacentInColumn(groups, 3, 0, 1)).toBe(3);
    expect(adjacentInColumn(groups, 3, 2, 1)).toBe(8);
    expect(adjacentInColumn(groups, 3, 3, 1)).toBe(5);
    expect(adjacentInColumn(groups, 3, 4, 1)).toBe(7);
    expect(adjacentInColumn(groups, 3, 9, 1)).toBeUndefined();
    expect(adjacentInColumn(groups, 3, 6, -1)).toBe(5);
    expect(adjacentInColumn(groups, 3, 8, -1)).toBe(2);
    expect(adjacentInColumn(groups, 3, 0, -1)).toBeUndefined();
    expect(adjacentInColumn([4], 1, 2, 1)).toBe(3);
  });
});

describe("moving through a collection", () => {
  test("an arrow key rerenders only the two items whose tab stop changed", () => {
    const keys = keysOf(50);
    const renders = new Map<string, number>();

    function CountingTarget({ id }: { id: string }) {
      renders.set(id, (renders.get(id) ?? 0) + 1);

      return (
        <button type="button" data-item-target tabIndex={useItemTabIndex()}>
          {id}
        </button>
      );
    }

    mount(
      <ItemNavigation itemKeys={keys} layout="list">
        <ItemTableBody>
          {keys.map((key) => (
            <ItemTableRow key={key} itemKey={key}>
              <CountingTarget id={key} />
            </ItemTableRow>
          ))}
        </ItemTableBody>
      </ItemNavigation>,
      createFakeApi({}),
    );

    act(() => screen.getByRole("button", { name: "item-0" }).focus());
    renders.clear();

    fireEvent.keyDown(screen.getByRole("button", { name: "item-0" }), { key: "ArrowDown" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "item-1" }));
    expect([...renders.keys()].toSorted()).toEqual(["item-0", "item-1"]);
    expect(screen.getByRole("button", { name: "item-1" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("button", { name: "item-0" }).getAttribute("tabindex")).toBe("-1");
  });
});

describe("long collections", () => {
  test("mount a bounded window at their true position and report the whole set", async () => {
    stubLayout();
    mount(<LongList keys={keysOf(1000)} />, createFakeApi({}));

    expect(renderedRows().length).toBeLessThan(40);
    expect(renderedRows()[0]?.getAttribute("aria-setsize")).toBe("1000");
    expect(renderedRows()[0]?.getAttribute("aria-posinset")).toBe("1");

    const list = screen.getByRole("list", { name: "Long list" });

    expect(Number.parseFloat(list.style.paddingBottom)).toBeGreaterThan(30_000);

    act(() => scrollTo(20_000));

    await waitFor(() => expect(screen.queryByRole("button", { name: "item-500" })).not.toBeNull());
    expect(renderedRows().length).toBeLessThan(50);
  });

  test("the focused row stays mounted and focused after scrolling far away", async () => {
    stubLayout();
    mount(<LongList keys={keysOf(1000)} />, createFakeApi({}));

    const row = screen.getByRole("button", { name: "item-2" });

    act(() => row.focus());
    act(() => scrollTo(20_000));

    await waitFor(() => expect(screen.queryByRole("button", { name: "item-500" })).not.toBeNull());

    expect(document.activeElement).toBe(row);
    expect(row.isConnected).toBe(true);

    const pinned = row.closest("li");

    expect(pinned?.style.position).toBe("absolute");
    expect(pinned?.style.top).toBe(`${2 * ROW_HEIGHT}px`);
    expect(pinned?.getAttribute("aria-posinset")).toBe("3");
  });

  test("the keyboard reaches rows that aren't mounted yet", () => {
    stubLayout();
    mount(<LongList keys={keysOf(1000)} />, createFakeApi({}));

    const first = screen.getByRole("button", { name: "item-0" });

    act(() => first.focus());
    expect(screen.queryByRole("button", { name: "item-999" })).toBeNull();

    fireEvent.keyDown(first, { key: "End" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "item-999" }));
    expect(screen.getByRole("button", { name: "item-999" }).getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("tabindex")).toBe("-1");
  });

  test("there's always a tab stop, even with its row scrolled away", async () => {
    stubLayout();
    mount(<LongList keys={keysOf(1000)} />, createFakeApi({}));

    act(() => scrollTo(20_000));
    await waitFor(() => expect(screen.queryByRole("button", { name: "item-500" })).not.toBeNull());

    expect(screen.getByRole("button", { name: "item-0" }).getAttribute("tabindex")).toBe("0");
  });

  test("removing a focused row focuses its replacement", async () => {
    stubLayout();

    const keys = keysOf(1000);
    const view = mount(<LongList keys={keys} />, createFakeApi({}));

    const end = screen.getByRole("button", { name: "item-0" });

    act(() => end.focus());
    fireEvent.keyDown(end, { key: "End" });

    const last = screen.getByRole("button", { name: "item-999" });

    expect(document.activeElement).toBe(last);
    act(() => last.blur());

    view.rerender(<LongList keys={keys.slice(0, 999)} />);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "item-998" })),
    );
  });

  test("crossing the threshold never remounts a row, so its focus survives", () => {
    const view = mount(<LongList keys={keysOf(150)} />, createFakeApi({}));
    const row = screen.getByRole("button", { name: "item-149" });

    expect(renderedRows()).toHaveLength(150);
    act(() => row.focus());
    stubLayout();
    view.rerender(<LongList keys={keysOf(250)} />);

    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(renderedRows().length).toBeLessThan(150);
  });

  test("small collections render whole, with no window attributes at all", () => {
    stubLayout();
    mount(<LongList keys={keysOf(30)} />, createFakeApi({}));

    expect(renderedRows()).toHaveLength(30);
    expect(renderedRows()[0]?.getAttribute("aria-setsize")).toBeNull();
    expect(screen.getByRole("list", { name: "Long list" }).style.position).toBe("");
  });

  test("without a measurable layout, every item stays reachable", async () => {
    mount(<LongList keys={keysOf(400)} />, createFakeApi({}));

    await waitFor(() => expect(renderedRows()).toHaveLength(400));
  });

  test("sections each keep their own position in the set", () => {
    stubLayout();

    const sections = [
      { key: "a", items: keysOf(300) },
      { key: "b", items: ["last"] },
    ];

    mount(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <VirtualSections
          sections={sections}
          itemKey={(key) => key}
          list={<ItemTableBody />}
          renderSection={(key, content) => (
            <section aria-label={key} key={key}>
              {content}
            </section>
          )}
        >
          {(key) => <Row id={key} />}
        </VirtualSections>
      </div>,
      createFakeApi({}),
    );

    expect(screen.getByRole("region", { name: "b" })).toBeTruthy();
    expect(renderedRows()[0]?.getAttribute("aria-setsize")).toBe("300");
  });
});

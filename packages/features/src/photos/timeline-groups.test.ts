import { expect, test } from "bun:test";
import { groupTimelineByDay, timelineDayLabel } from "#features/photos/timeline-groups.ts";

const at = (id: string, day: string) => ({ id, day });

// A fixed present, so relative labels don't depend on when the test runs.
const NOW = new Date(2026, 10, 19, 9, 30);

test("keeps server order and labels runs of the same day", () => {
  const groups = groupTimelineByDay(
    [at("a", "2026-11-19"), at("b", "2026-11-19"), at("c", "2026-11-18"), at("d", "2026-10-30")],
    (item) => item.day,
    NOW,
  );

  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([
    ["a", "b"],
    ["c"],
    ["d"],
  ]);
  expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", expect.any(String)]);
  expect(groups[2]!.label).not.toContain("2026");
});

test("a day the server order revisits becomes its own run, not a silent merge", () => {
  const groups = groupTimelineByDay(
    [at("a", "2026-11-19"), at("b", "2026-11-17"), at("c", "2026-11-19")],
    (item) => item.day,
    NOW,
  );

  expect(groups.map((group) => group.key)).toEqual(["2026-11-19", "2026-11-17", "2026-11-19"]);
  expect(groups.map((group) => group.label)).toEqual(["Today", expect.any(String), "Today"]);
});

test("the first run of a month names the month; later runs in it don't repeat it", () => {
  const groups = groupTimelineByDay(
    [at("a", "2026-11-19"), at("b", "2026-11-18"), at("c", "2026-10-31"), at("d", "2024-01-06")],
    (item) => item.day,
    NOW,
  );

  expect(groups.map((group) => group.month)).toEqual([
    expect.stringContaining("2026"),
    null,
    expect.stringContaining("2026"),
    expect.stringContaining("2024"),
  ]);
  expect(groups[0]!.month).not.toBe(groups[2]!.month);
});

test("day labels stay relative only while fresh, then shortest unambiguous", () => {
  expect(timelineDayLabel("2026-11-19", NOW)).toBe("Today");
  expect(timelineDayLabel("2026-11-18", NOW)).toBe("Yesterday");
  // Same year stays short; another year keeps the year, like the Files listing's dates.
  expect(timelineDayLabel("2026-11-02", NOW)).not.toContain("2026");
  expect(timelineDayLabel("2025-12-31", NOW)).toContain("2025");
});

test("an empty timeline has no groups", () => {
  expect(groupTimelineByDay([], (item: { day: string }) => item.day, NOW)).toEqual([]);
});

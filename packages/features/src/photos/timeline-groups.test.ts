import { expect, test } from "bun:test";
import { groupByMonth } from "#features/photos/timeline-groups.ts";

const at = (id: string, createdAt: string) => ({ id, createdAt });

test("keeps server order and groups consecutive months", () => {
  const groups = groupByMonth([
    at("a", "2026-11-20T12:00:00.000Z"),
    at("b", "2026-11-02T12:00:00.000Z"),
    at("c", "2026-09-15T12:00:00.000Z"),
  ]);

  expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
});

test("an empty timeline has no groups", () => {
  expect(groupByMonth([])).toEqual([]);
});

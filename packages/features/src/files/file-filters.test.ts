import { expect, test } from "bun:test";
import {
  hasActiveFilters,
  modifiedAfter,
  NO_FILTERS,
  toListFilesInput,
} from "#features/files/file-filters.ts";

test("no filters asks only for the folder", () => {
  expect(toListFilesInput("f1", "files", NO_FILTERS)).toEqual({ parentId: "f1", view: "files" });
  expect(hasActiveFilters(NO_FILTERS)).toBe(false);
});

test("filters map onto the declared list fields", () => {
  const input = toListFilesInput(null, "shared", {
    search: "tax",
    type: "application/pdf",
    modified: "week",
    modifiedAfter: "2026-01-01T00:00:00.000Z",
    size: "medium",
  });

  expect(input).toEqual({
    parentId: null,
    view: "shared",
    search: "tax",
    type: "application/pdf",
    after: "2026-01-01T00:00:00.000Z",
    minSize: 10 * 1024 ** 2,
    maxSize: 100 * 1024 ** 2,
  });
});

test("modified presets are computed from the supplied clock", () => {
  expect(modifiedAfter("any", 0)).toBeUndefined();
  expect(modifiedAfter("week", 7 * 86_400_000)).toBe(new Date(0).toISOString());
});

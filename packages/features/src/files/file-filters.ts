import type { InputOf, RPC } from "@hyori-cloud/client-sdk";

export type ListFilesInput = InputOf<RPC["files"]["list"]>;

export type FileView = "files" | "shared";

export const FILE_TYPE_OPTIONS = [
  { value: "any", label: "Any type" },
  { value: "folder", label: "Folders" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "application/pdf", label: "PDFs" },
  { value: "text", label: "Text" },
] as const;

export type FileTypeFilter = (typeof FILE_TYPE_OPTIONS)[number]["value"];

export const MODIFIED_OPTIONS = [
  { value: "any", label: "Any date" },
  { value: "week", label: "Past 7 days" },
  { value: "month", label: "Past 30 days" },
  { value: "year", label: "Past year" },
] as const;

export type ModifiedFilter = (typeof MODIFIED_OPTIONS)[number]["value"];

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export const SIZE_OPTIONS = [
  { value: "any", label: "Any size" },
  { value: "small", label: "Under 10 MB" },
  { value: "medium", label: "10 MB – 100 MB" },
  { value: "large", label: "100 MB – 1 GB" },
  { value: "huge", label: "Over 1 GB" },
] as const;

export type SizeFilter = (typeof SIZE_OPTIONS)[number]["value"];

const SIZE_RANGES: Record<SizeFilter, { minSize?: number; maxSize?: number }> = {
  any: {},
  small: { maxSize: 10 * MB },
  medium: { minSize: 10 * MB, maxSize: 100 * MB },
  large: { minSize: 100 * MB, maxSize: GB },
  huge: { minSize: GB },
};

const MODIFIED_DAYS: Record<Exclude<ModifiedFilter, "any">, number> = {
  week: 7,
  month: 30,
  year: 365,
};

export type FileFilters = {
  readonly search: string;
  readonly type: FileTypeFilter;
  readonly modified: ModifiedFilter;
  /** Fixed when the filter is chosen, so the query key stays stable between renders. */
  readonly modifiedAfter: string | undefined;
  readonly size: SizeFilter;
};

export const NO_FILTERS: FileFilters = {
  search: "",
  type: "any",
  modified: "any",
  modifiedAfter: undefined,
  size: "any",
};

export function hasActiveFilters(filters: FileFilters): boolean {
  return (
    filters.search !== "" ||
    filters.type !== "any" ||
    filters.modified !== "any" ||
    filters.size !== "any"
  );
}

/** Search has its own always-visible field, so this counts only what the filter bar can hide. */
export function countBarFilters(filters: FileFilters): number {
  return [filters.type, filters.modified, filters.size].filter((value) => value !== "any").length;
}

export function modifiedAfter(filter: ModifiedFilter, now: number): string | undefined {
  if (filter === "any") return undefined;

  return new Date(now - MODIFIED_DAYS[filter] * 86_400_000).toISOString();
}

export function toListFilesInput(
  parentId: string | null,
  view: FileView,
  filters: FileFilters,
): ListFilesInput {
  return {
    parentId,
    view,
    search: filters.search === "" ? undefined : filters.search,
    type: filters.type === "any" ? undefined : filters.type,
    after: filters.modifiedAfter,
    ...SIZE_RANGES[filters.size],
  };
}

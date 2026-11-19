import { useSyncExternalStore } from "@hyori-cloud/lib/react";
import { useServerBrowserPreferences } from "@hyori-cloud/ui/components/browser-preferences-provider";
import { mirrorBrowserPreferences } from "@hyori-cloud/ui/lib/browser-preferences";
import type { ListFilesInput } from "#features/files/file-filters.ts";

export type FileSort = NonNullable<ListFilesInput["sort"]>;

export const FILE_SORT_OPTIONS = [
  { value: "nameAsc", label: "Name, A to Z" },
  { value: "nameDesc", label: "Name, Z to A" },
  { value: "sizeAsc", label: "Size, smallest first" },
  { value: "sizeDesc", label: "Size, largest first" },
  { value: "modifiedAsc", label: "Modified, oldest first" },
  { value: "modifiedDesc", label: "Modified, newest first" },
] as const satisfies readonly { value: FileSort; label: string }[];

const KEY = "hyori-file-sort";
const listeners = new Set<() => void>();
let unstored: FileSort | null = null;

/** The stored sort, for callers outside React that need the key the Files screen will use. */
export function readSort(): FileSort {
  if (unstored !== null) return unstored;

  try {
    const value = localStorage.getItem(KEY);

    return FILE_SORT_OPTIONS.find((option) => option.value === value)?.value ?? "nameAsc";
  } catch {
    return "nameAsc";
  }
}

function writeSort(sort: FileSort) {
  try {
    localStorage.setItem(KEY, sort);
    unstored = null;
  } catch {
    unstored = sort;
  }

  mirrorBrowserPreferences({ fileSort: sort });

  for (const listener of listeners) listener();
}

function subscribeSort(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      mirrorBrowserPreferences();
      listener();
    }
  };

  listeners.add(listener);
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFileSort() {
  const preferences = useServerBrowserPreferences();

  return [
    useSyncExternalStore(subscribeSort, readSort, () => preferences.fileSort),
    writeSort,
  ] as const;
}

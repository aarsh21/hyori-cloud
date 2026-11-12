export type ItemLayout = "list" | "grid";

const STORAGE_KEY = "hyori-item-layout";

const listeners = new Set<() => void>();

// Storage may be blocked. The choice then lasts for this page instead of doing nothing.
let unstored: ItemLayout | null = null;

/** Host adapter over `localStorage`: listings stay in rows unless this browser chose otherwise. */
export function readItemLayout(): ItemLayout {
  if (unstored !== null) return unstored;

  try {
    return localStorage.getItem(STORAGE_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function writeItemLayout(layout: ItemLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, layout);
    unstored = null;
  } catch {
    unstored = layout;
  }

  for (const listener of listeners) listener();
}

/** Other tabs report changes through `storage`; this tab's own writes notify directly. */
export function subscribeItemLayout(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };

  listeners.add(listener);
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

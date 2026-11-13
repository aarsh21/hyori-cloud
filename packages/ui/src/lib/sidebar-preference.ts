import { mirrorBrowserPreferences } from "@hyori-cloud/ui/lib/browser-preferences";

const STORAGE_KEY = "hyori-sidebar";

const listeners = new Set<() => void>();

// Storage may be blocked. The choice then lasts for this page instead of doing nothing.
let unstored: boolean | null = null;

/** Host adapter over `localStorage`: the sidebar stays open unless this browser chose otherwise. */
export function readSidebarOpen() {
  if (unstored !== null) return unstored;

  try {
    return localStorage.getItem(STORAGE_KEY) !== "collapsed";
  } catch {
    return true;
  }
}

export function writeSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "open" : "collapsed");
    unstored = null;
  } catch {
    unstored = open;
  }

  mirrorBrowserPreferences({ sidebarOpen: open });

  for (const listener of listeners) listener();
}

/** Other tabs report changes through `storage`; this tab's own writes notify directly. */
export function subscribeSidebarOpen(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
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

import { mirrorBrowserPreferences } from "@hyori-cloud/ui/lib/browser-preferences";

const STORAGE_KEY = "hyori-single-key-shortcuts";

const listeners = new Set<() => void>();

// Storage may be blocked. The choice then lasts for this page instead of doing nothing.
let unstored: boolean | null = null;

/** Host adapter over `localStorage`: single-key shortcuts stay on unless this browser chose otherwise. */
export function readSingleKeyShortcuts() {
  if (unstored !== null) return unstored;

  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSingleKeyShortcuts(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
    unstored = null;
  } catch {
    unstored = enabled;
  }

  mirrorBrowserPreferences({ singleKeyShortcuts: enabled });

  for (const listener of listeners) listener();
}

/** Other tabs report changes through `storage`; this tab's own writes notify directly. */
export function subscribeSingleKeyShortcuts(listener: () => void) {
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

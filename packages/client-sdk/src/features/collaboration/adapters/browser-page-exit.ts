import type { CollaborationPageExit } from "../../../collaboration.ts";

/**
 * A page that is closing, reloading or navigating away fires `pagehide`, even when it then enters
 * the back/forward cache. `beforeunload` only asks, and a person can stay. Outside a browser there
 * is no page to leave.
 */
export function createBrowserPageExit(): CollaborationPageExit | undefined {
  if (typeof window === "undefined") return undefined;

  return {
    subscribe(listener) {
      window.addEventListener("pagehide", listener);

      return () => window.removeEventListener("pagehide", listener);
    },
  };
}

import { useEffect } from "react";

/**
 * Host adapter. Starts a code preload once the browser has nothing more urgent to do, so it never
 * competes with the screen that asked for it. Registered as a host adapter so portable features can
 * say only what they will need next.
 */
export function usePreloadWhenIdle(preload: (() => void) | null) {
  useEffect(() => {
    if (preload === null) return undefined;

    // Safari has no idle callback.
    if (!("requestIdleCallback" in window)) {
      const timer = setTimeout(preload, 200);

      return () => clearTimeout(timer);
    }

    const idle = requestIdleCallback(preload, { timeout: 2000 });

    return () => cancelIdleCallback(idle);
  }, [preload]);
}

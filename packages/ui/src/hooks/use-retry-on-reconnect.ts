import { useEffect, useEffectEvent } from "react";

/** Host adapter: retry a failed region on reconnect, releasing the listener when it leaves. */
export function useRetryOnReconnect(enabled: boolean, retry: () => void) {
  const onReconnect = useEffectEvent(retry);

  useEffect(() => {
    if (!enabled) return;

    const listener = () => onReconnect();
    window.addEventListener("online", listener);

    // Connectivity may have returned between the failed render and this subscription.
    if (navigator.onLine) onReconnect();

    return () => window.removeEventListener("online", listener);
  }, [enabled]);
}

import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Host adapter. Releases a resource when its React owner leaves for real. Disposal is deferred one
 * task and cancelled on remount, because Strict Mode's simulated unmount must not kill a resource
 * created once in a `useState` initializer. Registered as a host adapter.
 */
export function useDisposeOnUnmount(dispose: () => void) {
  const release = useEffectEvent(dispose);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(pending.current);

    return () => {
      pending.current = setTimeout(() => release(), 0);
    };
  }, []);
}

import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

function subscribe(listener: () => void) {
  const query = matchMedia(QUERY);

  query.addEventListener("change", listener);

  return () => query.removeEventListener("change", listener);
}

function read() {
  return matchMedia(QUERY).matches;
}

/**
 * Host adapter over `(pointer: coarse)`, the same test as the `coarse:` variant. The server can't
 * know the pointer, so it renders the pointer layout and a touch device switches after hydration.
 */
export function useCoarsePointer() {
  return useSyncExternalStore(subscribe, read, () => false);
}

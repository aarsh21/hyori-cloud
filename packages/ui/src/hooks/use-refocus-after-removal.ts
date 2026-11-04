import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Host adapter. Removing the focused row sends focus to `<body>`, which strands keyboard users at the
 * top of the page, and the DOM reports that only after commit. Focus moves to the row that took its
 * place. A list with nothing in common with the last one is a different list, so it's left alone.
 */
export function useRefocusAfterRemoval(
  container: RefObject<HTMLElement | null>,
  itemKeys: readonly string[],
  focusedKey: string | null,
) {
  const previousKeys = useRef(itemKeys);

  useLayoutEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = itemKeys;

    if (focusedKey === null || itemKeys.includes(focusedKey)) return;

    const previousSet = new Set(previous);

    if (!previousSet.has(focusedKey) || !itemKeys.some((key) => previousSet.has(key))) return;

    if (document.activeElement !== null && document.activeElement !== document.body) return;

    const replacement = itemKeys[Math.min(previous.indexOf(focusedKey), itemKeys.length - 1)];

    for (const row of container.current?.querySelectorAll<HTMLElement>("[data-item-key]") ?? []) {
      if (row.dataset.itemKey === replacement) {
        row.querySelector<HTMLElement>("[data-item-target]")?.focus({ preventScroll: true });
      }
    }
  }, [container, itemKeys, focusedKey]);
}

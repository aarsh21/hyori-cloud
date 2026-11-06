import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

function focusItem(container: HTMLElement | null, itemKey: string) {
  for (const row of container?.querySelectorAll<HTMLElement>("[data-item-key]") ?? []) {
    if (row.dataset.itemKey === itemKey) {
      row.querySelector<HTMLElement>("[data-item-target]")?.focus({ preventScroll: true });

      return true;
    }
  }

  return false;
}

/**
 * Host adapter. Removing the focused row sends focus to `<body>`, which strands keyboard users at the
 * top of the page, and the DOM reports that only after commit. Focus moves to the row that took its
 * place. A list with nothing in common with the last one is a different list, so it's left alone.
 * A replacement outside the rendered window is pinned through `activate` and focused once mounted.
 */
export function useRefocusAfterRemoval(
  container: RefObject<HTMLElement | null>,
  itemKeys: readonly string[],
  focusedKey: string | null,
  activate: (itemKey: string) => void,
) {
  const previousKeys = useRef(itemKeys);
  const awaiting = useRef<string | null>(null);

  useLayoutEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = itemKeys;

    if (awaiting.current !== null) {
      focusItem(container.current, awaiting.current);
      awaiting.current = null;

      return;
    }

    if (focusedKey === null || itemKeys.includes(focusedKey)) return;

    const previousSet = new Set(previous);

    if (!previousSet.has(focusedKey) || !itemKeys.some((key) => previousSet.has(key))) return;

    if (document.activeElement !== null && document.activeElement !== document.body) return;

    const replacement = itemKeys[Math.min(previous.indexOf(focusedKey), itemKeys.length - 1)];

    if (replacement === undefined || focusItem(container.current, replacement)) return;

    awaiting.current = replacement;
    activate(replacement);
  }, [container, itemKeys, focusedKey, activate]);
}

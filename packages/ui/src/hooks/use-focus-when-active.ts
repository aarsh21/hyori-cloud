import { useEffect, useRef } from "react";

/**
 * Host adapter. Focus is DOM synchronization, so portable features hand the intent over as a
 * callback instead of reaching for an effect. The target can mount long after its route does,
 * or a pane can turn focusable as its content changes, so focus runs on each rise of `active`
 * and never on unrelated re-renders or repeats while it stays active.
 */
export function useFocusWhenActive(active: boolean, focus: () => void) {
  const focused = useRef(false);

  useEffect(() => {
    if (!active) {
      focused.current = false;

      return;
    }

    if (focused.current) return;

    focused.current = true;
    focus();
  }, [active, focus]);
}

import { useEffect, useEffectEvent, useState } from "react";

/**
 * Host adapter. Owns one scroll listener on the page body nearest an element, coalesced to a
 * frame, and the settle timer that keeps a rail on screen while the page is still moving. The
 * frame callback decides what a scroll means; this only owns when it runs, and never while the
 * element has no page body to follow. Registered as a host adapter so portable features can
 * track the page without owning an effect.
 */
export function useScrollActivity(
  anchor: { readonly current: HTMLElement | null },
  onFrame: () => void,
  settleMs: number,
) {
  const frame = useEffectEvent(onFrame);
  const [scrolling, setScrolling] = useState(false);

  useEffect(() => {
    const scroller = anchor.current?.closest<HTMLElement>("[data-slot='page-body']") ?? null;

    if (scroller === null) return undefined;

    let raf = 0;
    let settle: number | undefined;

    const onScroll = () => {
      setScrolling(true);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setScrolling(false), settleMs);

      // The handle goes back to zero when the frame runs, so the next scroll gets its own.
      if (raf === 0) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          frame();
        });
      }
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(settle);

      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [anchor, settleMs]);

  return scrolling;
}

import { useScrollActivity } from "@hyori-cloud/ui/hooks/use-scroll-activity";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { useRef, useState } from "@hyori-cloud/lib/react";

export type ScrubberMonth = {
  /** `YYYY-MM`, unique per month in timeline order. */
  readonly key: string;
  /** The formatted month label the rail shows. */
  readonly label: string;
  /** The day section this month starts at, which is its scroll target. */
  readonly dayKey: string;
};

// The rail shows on touch only while the page is actually moving, then fades back out.
const SCROLL_SETTLE_MS = 700;

/**
 * A month rail over the timeline, for fast travel through a long one. A press-drag jumps between
 * months and a hover previews them; the arrows step the same order for a keyboard. The months are
 * the loaded ones, in the timeline's own order, so the thumb always stands for what's on screen.
 */
export function PhotoScrubber({ months }: { months: readonly ScrubberMonth[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef(new Map<string, HTMLElement>());
  const draggingRef = useRef(false);
  const [index, setIndex] = useState(0);

  const [preview, setPreview] = useState<{
    readonly index: number;
    readonly fraction: number;
  } | null>(null);

  const [dragging, setDragging] = useState(false);

  // While the page scrolls, the thumb tracks which month is on screen.
  const scrolling = useScrollActivity(
    railRef,
    () => {
      // A drag is ahead of the scroll it caused; the thumb follows the hand, not the flight.
      if (draggingRef.current) return;

      const scroller = railRef.current?.closest<HTMLElement>("[data-slot='page-body']");

      if (scroller === null || scroller === undefined) return;

      const bounds = scroller.getBoundingClientRect();
      let next = 0;

      // The month on screen is the last one whose section top is at or above the fold line.
      for (const [i, month] of months.entries()) {
        const section = sectionOf(month.dayKey);

        if (section === null) continue;

        if (section.getBoundingClientRect().top - bounds.top > 48) break;
        next = i;
      }

      setIndex(next);
    },
    SCROLL_SETTLE_MS,
  );

  const clamp = (candidate: number) => Math.min(months.length - 1, Math.max(0, candidate));

  function sectionOf(dayKey: string): HTMLElement | null {
    const cached = sectionsRef.current.get(dayKey);

    if (cached !== undefined && cached.isConnected) return cached;

    const found = document.querySelector<HTMLElement>(`[data-day-key="${dayKey}"]`);

    if (found === null) sectionsRef.current.delete(dayKey);
    else sectionsRef.current.set(dayKey, found);

    return found;
  }

  function jumpTo(next: number) {
    const month = months[next];

    if (month === undefined) return;

    // A month past what's loaded has no section yet; the drag that reaches for it lands on the
    // last one, which brings the next page in behind the movement.
    sectionOf(month.dayKey)?.scrollIntoView({ block: "start" });
    setIndex(next);
  }

  const monthAt = (clientY: number) => {
    const rail = railRef.current;

    if (rail === null) return null;

    const rect = rail.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(rect.height, 1)));

    return { index: clamp(Math.round(fraction * (months.length - 1))), fraction };
  };

  const endDrag = () => {
    draggingRef.current = false;
    setDragging(false);
    setPreview(null);
  };

  const visible = dragging || scrolling;
  const previewMonth = preview === null ? undefined : months[preview.index];

  return (
    <div
      ref={railRef}
      role="slider"
      tabIndex={0}
      aria-label="Jump to month"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={months.length - 1}
      aria-valuenow={index}
      aria-valuetext={months[index]?.label}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
        setDragging(true);

        const target = monthAt(event.clientY);

        if (target === null) return;

        setPreview(target);
        jumpTo(target.index);
      }}
      onPointerMove={(event) => {
        // Hover previews the month under the pointer; a press-drag goes there.
        const target = monthAt(event.clientY);

        if (target === null) return;

        setPreview(target);

        if (draggingRef.current) jumpTo(target.index);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        if (!draggingRef.current) setPreview(null);
      }}
      onKeyDown={(event) => {
        let next = index;

        switch (event.key) {
          case "ArrowUp":
            next = index - 1;
            break;
          case "ArrowDown":
            next = index + 1;
            break;
          case "PageUp":
            next = index - 4;
            break;
          case "PageDown":
            next = index + 4;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = months.length - 1;
            break;
          default:
            return;
        }

        if (next === index) return;

        event.preventDefault();
        jumpTo(clamp(next));
      }}
      className={cn(
        "absolute inset-y-0 right-0 z-10 w-6 touch-none cursor-pointer outline-none transition-opacity duration-150",
        "focus-visible:opacity-100 fine:w-4",
        visible ? "opacity-100" : "opacity-0 fine:hover:opacity-100 coarse:pointer-events-none",
      )}
    >
      <div
        aria-hidden
        className="absolute inset-y-6 right-1.5 w-[3px] rounded-full bg-foreground/20 fine:right-1"
      />
      <div
        aria-hidden
        className="absolute right-1 h-6 w-1.5 -translate-y-1/2 rounded-full bg-foreground/70"
        style={{ top: `calc(1.5rem + (100% - 3rem) * ${index / (months.length - 1)})` }}
      />
      {previewMonth !== undefined ? (
        <span
          className="pointer-events-none absolute right-full mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-[13px] font-medium text-popover-foreground ring-1 ring-border"
          style={{ top: `calc(1.5rem + (100% - 3rem) * ${preview?.fraction})` }}
        >
          {previewMonth.label}
        </span>
      ) : null}
    </div>
  );
}

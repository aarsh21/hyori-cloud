import { useEffect, useRef } from "react";
import { createImageLoadSlot } from "../lib/image-load-slots";

const SCROLL_PAUSE_MS = 120;
const MAX_SCROLL_WAIT_MS = 750;
const pending = new Map<() => void, number>();
let consumers = 0;
let lastScroll = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined;

function resumeSources() {
  timer = undefined;

  const now = performance.now();

  for (const [start, latest] of pending) {
    if (now - lastScroll < SCROLL_PAUSE_MS && now < latest) continue;
    pending.delete(start);
    start();
  }

  if (pending.size > 0) scheduleSources();
}

function scheduleSources() {
  clearTimeout(timer);

  const next = Math.min(lastScroll + SCROLL_PAUSE_MS, ...pending.values());

  timer = setTimeout(resumeSources, Math.max(0, next - performance.now()));
}

function noteScroll() {
  lastScroll = performance.now();

  if (pending.size > 0) scheduleSources();
}

function afterScroll(start: () => void, latest: number) {
  const now = performance.now();

  if (now - lastScroll >= SCROLL_PAUSE_MS || now >= latest) {
    start();

    return () => {};
  }

  pending.set(start, latest);
  scheduleSources();

  return () => {
    pending.delete(start);
  };
}

/**
 * Host adapter. Owns an image's native source, viewport admission and transfer-slot lifetime.
 * Keep src off the JSX element: admission needs no React commit as the collection scrolls.
 * New sources wait for a short scroll pause, at most 750ms so continuous reading cannot starve.
 * Queued sources that leave the viewport cancel; admission still shares the six-transfer limit.
 * Callers still own rendering load/error states and must remount when the source changes.
 */
export function useLazyImageSource(src: string) {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = ref.current;

    if (image === null) return undefined;

    if (consumers++ === 0) document.addEventListener("scroll", noteScroll, true);

    let entered = false;
    let stopWaiting = () => {};

    const observer = new IntersectionObserver(
      (entries) => {
        // An already queued intersection record must not cancel an admitted transfer.
        if (image.hasAttribute("src")) return;

        if (!entries.at(-1)?.isIntersecting) {
          stopWaiting();
          entered = false;

          return;
        }

        if (entered) return;
        entered = true;

        const latest = performance.now() + MAX_SCROLL_WAIT_MS;
        const slot = createImageLoadSlot();
        let cancelSource = () => {};

        image.addEventListener("load", slot.finish);
        image.addEventListener("error", slot.finish);

        const leave = slot.subscribe(() => {
          cancelSource = afterScroll(() => {
            observer.disconnect();
            image.src = src;
          }, latest);
        });

        stopWaiting = () => {
          cancelSource();
          image.removeEventListener("load", slot.finish);
          image.removeEventListener("error", slot.finish);
          leave();
        };
      },
      { rootMargin: "200px" },
    );

    observer.observe(image);

    return () => {
      observer.disconnect();
      stopWaiting();
      image.removeAttribute("src");

      if (--consumers === 0) {
        document.removeEventListener("scroll", noteScroll, true);
        clearTimeout(timer);
        lastScroll = -Infinity;
      }
    };
  }, [src]);

  return ref;
}

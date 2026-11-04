import { useEffect, useRef, useState } from "react";

/**
 * Host adapter. Viewport visibility has no React primitive, so this owns one IntersectionObserver
 * until the element first nears the screen. Registered as a host adapter so portable tiles can
 * request previews on demand without touching the effect.
 */
export function useEnteredViewport<Target extends Element>() {
  const [entered, setEntered] = useState(false);
  const ref = useRef<Target>(null);

  useEffect(() => {
    const element = ref.current;

    if (element === null || entered) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setEntered(true);
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, [entered]);

  return [entered, ref] as const;
}

import type { ReactNode } from "@hyori-cloud/lib/react";
import { useState } from "@hyori-cloud/lib/react";
import { useLazyImageSource } from "@hyori-cloud/ui/hooks/use-lazy-image-source";

/** Loaded separately from Files' first document; only a server-provided ready URL reaches here. */
export default function FileThumbnail({ src, fallback }: { src: string; fallback: ReactNode }) {
  const ref = useLazyImageSource(src);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  return (
    <span className="relative grid size-full place-items-center overflow-hidden rounded-sm">
      <span
        className={`grid size-full place-items-center ${state === "ready" ? "invisible" : "visible"}`}
      >
        {fallback}
      </span>
      {state !== "failed" ? (
        <img
          ref={ref}
          data-slot={state === "ready" ? "file-thumbnail" : undefined}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => {
            setState("ready");
          }}
          onError={() => {
            setState("failed");
          }}
          className={`absolute inset-0 size-full object-cover ${state === "ready" ? "visible" : "invisible"}`}
        />
      ) : null}
    </span>
  );
}

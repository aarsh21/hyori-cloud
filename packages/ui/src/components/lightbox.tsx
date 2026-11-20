"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import * as React from "react";

const SWIPE_THRESHOLD_PX = 48;
const FLICK_MINIMUM_PX = 16;
const FLICK_PX_PER_MS = 0.11;

// Zoom is bounded like a camera app: 4× is plenty for inspecting a photo.
const ZOOM_MAX = 4;
const ZOOM_STEP = 2;

type SwipeStart = { readonly x: number; readonly y: number; readonly at: number };

type ZoomView = { scale: number; x: number; y: number };

type PinchGesture = {
  readonly mode: "pinch";
  readonly startDistance: number;
  readonly startScale: number;
  readonly contentX: number;
  readonly contentY: number;
};

type PanGesture = {
  readonly mode: "pan";
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originX: number;
  readonly originY: number;
};

/** The shell stands aside for a zoomed photo's gestures, and resets it when it closes. */
const ZoomContext = React.createContext<{
  readonly open: boolean;
  readonly setZoomed: (zoomed: boolean) => void;
}>({
  open: false,
  setZoomed: () => {},
});

/**
 * Full-screen viewer. Opening grows from the tile that was tapped when one can be found, and fades
 * otherwise. Moving between items is instant, because stepping through photos with arrow keys is
 * the most repeated action here and must never feel delayed.
 */
function Lightbox({
  open,
  onOpenChange,
  title,
  subtitle,
  onPrevious,
  onNext,
  onInfoToggle,
  origin,
  panel,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: React.ReactNode;
  onPrevious?: () => void;
  onNext?: () => void;
  onInfoToggle?: () => void;
  /** The tile this viewer opened from, so the media can grow out of it. */
  origin?: DOMRect | null;
  /** Extra content beside the media. Providing it also enables the details key and control. */
  panel?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const swipeStart = React.useRef<SwipeStart | null>(null);
  const livePointers = React.useRef(0);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const wasOpen = React.useRef(false);
  const [zoomed, setZoomed] = React.useState(false);

  // Grow from the tile on open, shrink back to it on close. Each is one transform write, so
  // reduced motion is honored by the stylesheet alone: it drops the transition and leaves a cut.
  React.useLayoutEffect(() => {
    const frame = frameRef.current;

    if (frame === null || origin === undefined || origin === null) {
      wasOpen.current = open;

      return;
    }

    const tile = origin;

    const transformFromTile = () => {
      const rect = frame.getBoundingClientRect();

      if (rect.width === 0) return null;

      const dx = tile.left + tile.width / 2 - (rect.left + rect.width / 2);
      const dy = tile.top + tile.height / 2 - (rect.top + rect.height / 2);

      return `translate(${dx}px, ${dy}px) scale(${tile.width / rect.width})`;
    };

    if (open && !wasOpen.current) {
      const transform = transformFromTile();

      if (transform !== null) {
        // Applied before paint, cleared in the next frame: the transition animates the release.
        frame.style.transitionDuration = "200ms";
        frame.style.transform = transform;
      }

      const release = requestAnimationFrame(() => {
        frame.style.transform = "";
      });

      wasOpen.current = open;

      return () => cancelAnimationFrame(release);
    }

    if (!open && wasOpen.current) {
      const transform = transformFromTile();

      // The popup fades over 150ms; a shrink to a tile still on screen matches it home.
      if (transform !== null) {
        frame.style.transitionDuration = "150ms";
        frame.style.transform = transform;
      }
    }

    wasOpen.current = open;
  }, [open, origin]);

  const zoomShell = React.useMemo(() => ({ open, setZoomed }), [open, setZoomed]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <ZoomContext value={zoomShell}>
          <DialogPrimitive.Popup
            data-slot="lightbox"
            className="fixed inset-0 z-50 flex flex-col bg-[oklch(0.134_0.005_262)] text-white outline-none transition-opacity duration-150 ease-(--ease-out) data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:opacity-0"
            onKeyDown={(event) => {
              // Portaled menu keystrokes bubble through React, and a focused video owns its arrows.
              const element = event.target;

              if (!(element instanceof Element) || !event.currentTarget.contains(element)) return;

              if (element.tagName === "VIDEO") return;

              if (event.key === "ArrowLeft" && onPrevious) {
                event.preventDefault();
                onPrevious();
              }

              if (event.key === "ArrowRight" && onNext) {
                event.preventDefault();
                onNext();
              }

              if (
                onInfoToggle !== undefined &&
                (event.key === "i" || event.key === "I") &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
              ) {
                event.preventDefault();
                onInfoToggle();
              }
            }}
          >
            <div className="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))]">
              <DialogPrimitive.Close aria-label="Close viewer" className={lightboxControlClasses}>
                <XIcon aria-hidden />
              </DialogPrimitive.Close>
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[13px] text-white/90">
                {title}
              </DialogPrimitive.Title>
              {subtitle !== undefined ? (
                <span className="shrink-0 text-[13px] tabular-nums text-white/55">{subtitle}</span>
              ) : null}
              {actions}
            </div>
            <div className="relative flex min-h-0 flex-1">
              <div
                role="none"
                data-slot="lightbox-stage"
                className="relative grid min-h-0 min-w-0 flex-1 touch-pan-y place-items-center select-none"
                onPointerDown={(event) => {
                  livePointers.current += 1;

                  // A pinch, or a photo that owns its zoom, never starts a swipe between items.
                  if (livePointers.current > 1 || zoomed) {
                    swipeStart.current = null;

                    return;
                  }

                  // A drag along a video's scrubber or across a control isn't a swipe either.
                  const started =
                    event.target instanceof Element &&
                    event.target.closest("video,button,a") === null;

                  swipeStart.current =
                    event.pointerType !== "mouse" && event.isPrimary && started
                      ? { x: event.clientX, y: event.clientY, at: event.timeStamp }
                      : null;
                }}
                onPointerCancel={() => {
                  livePointers.current = Math.max(0, livePointers.current - 1);
                  swipeStart.current = null;
                }}
                onPointerUp={(event) => {
                  livePointers.current = Math.max(0, livePointers.current - 1);

                  const start = swipeStart.current;

                  if (start === null || !event.isPrimary) return;
                  swipeStart.current = null;

                  const distance = event.clientX - start.x;
                  const reach = Math.abs(distance);
                  const drop = event.clientY - start.y;
                  const elapsed = Math.max(event.timeStamp - start.at, 1);

                  // A quick flick needs less distance than a full swipe.
                  const flicked = (px: number) =>
                    px >= FLICK_MINIMUM_PX && px / elapsed > FLICK_PX_PER_MS;

                  // Mostly vertical is the page's pan — except a downward drag, which dismisses.
                  if (reach <= Math.abs(drop)) {
                    if (
                      drop > 0 &&
                      (Math.abs(drop) >= SWIPE_THRESHOLD_PX || flicked(Math.abs(drop)))
                    ) {
                      onOpenChange(false);
                    }

                    return;
                  }

                  if (reach < SWIPE_THRESHOLD_PX && !flicked(reach)) return;

                  if (distance > 0) onPrevious?.();
                  else onNext?.();
                }}
              >
                <div
                  ref={frameRef}
                  className="relative grid h-full w-full place-items-center transition-transform ease-(--ease-out)"
                >
                  {children}
                </div>
                {onPrevious ? (
                  <button
                    type="button"
                    aria-label="Previous"
                    onClick={onPrevious}
                    className={cn(lightboxControlClasses, lightboxStageControlClasses, "left-3")}
                  >
                    <ChevronLeftIcon aria-hidden />
                  </button>
                ) : null}
                {onNext ? (
                  <button
                    type="button"
                    aria-label="Next"
                    onClick={onNext}
                    className={cn(lightboxControlClasses, lightboxStageControlClasses, "right-3")}
                  >
                    <ChevronRightIcon aria-hidden />
                  </button>
                ) : null}
              </div>
              {panel !== undefined && panel !== null ? (
                <aside
                  aria-label="Details"
                  className="flex max-h-full flex-col gap-3 overflow-y-auto overscroll-contain border-white/10 bg-black/60 px-4 py-3 text-white/85 max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[45dvh] max-md:rounded-t-xl max-md:border-t max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] md:w-72 md:shrink-0 md:border-l"
                >
                  {panel}
                </aside>
              ) : null}
            </div>
          </DialogPrimitive.Popup>
        </ZoomContext>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const lightboxControlClasses =
  "grid size-8 shrink-0 place-items-center rounded-md text-white/85 outline-none transition-colors duration-100 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white coarse:size-11 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]";

// These sit over the photo, so their own fill has to hold 3:1 against even a white one.
const lightboxStageControlClasses =
  "absolute size-10 bg-black/60 text-white ring-1 ring-white/25 hover:bg-black/75 coarse:size-11";

/**
 * Zoom, pan and pinch for one image, written straight to the element's transform: nothing here
 * re-renders per frame. The point under a tap or a pinch midpoint stays under it while scaling,
 * and the image drags only as far as it overflows the stage.
 */
function useImageZoom() {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const { open, setZoomed } = React.useContext(ZoomContext);
  const view = React.useRef<ZoomView>({ scale: 1, x: 0, y: 0 });
  const zoomedRef = React.useRef(false);
  const pointers = React.useRef(new Map<number, { x: number; y: number }>());
  const gesture = React.useRef<PinchGesture | PanGesture | null>(null);

  const stageCell = () =>
    boxRef.current?.closest<HTMLElement>("[data-slot='lightbox-stage']") ?? null;

  const fitted = () =>
    boxRef.current?.querySelector<HTMLElement>("[data-slot='lightbox-media']") ?? null;

  // A point's offset from the unzoomed image's center, inside the stage cell.
  const anchorOf = (clientX: number, clientY: number) => {
    const cell = stageCell();
    const media = fitted();

    if (cell === null || media === null) return null;

    const rect = cell.getBoundingClientRect();

    return {
      x: clientX - rect.left - (media.offsetLeft + media.offsetWidth / 2),
      y: clientY - rect.top - (media.offsetTop + media.offsetHeight / 2),
    };
  };

  const publishZoomed = (zoomed: boolean) => {
    if (zoomedRef.current === zoomed) return;
    zoomedRef.current = zoomed;
    setZoomed(zoomed);
  };

  const syncCursor = () => {
    if (boxRef.current !== null) {
      boxRef.current.style.cursor = view.current.scale > 1 ? "grab" : "zoom-in";
    }
  };

  const applyView = () => {
    const box = boxRef.current;

    if (box === null) return;

    const { scale, x, y } = view.current;

    // One transform composes zoom and pan; back at 1 it clears entirely.
    box.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
  };

  const clampPan = () => {
    const cell = stageCell();
    const media = fitted();

    if (cell === null || media === null) return;

    const { scale } = view.current;
    const maxX = Math.max(0, (media.offsetWidth * scale - cell.clientWidth) / 2);
    const maxY = Math.max(0, (media.offsetHeight * scale - cell.clientHeight) / 2);

    view.current.x = Math.min(maxX, Math.max(-maxX, view.current.x));
    view.current.y = Math.min(maxY, Math.max(-maxY, view.current.y));
  };

  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const anchor = anchorOf(clientX, clientY);

    if (anchor === null) return;

    const next = Math.min(ZOOM_MAX, Math.max(1, nextScale));
    const { scale, x, y } = view.current;
    const contentX = (anchor.x - x) / scale;
    const contentY = (anchor.y - y) / scale;

    view.current.scale = next;
    view.current.x = next === 1 ? 0 : anchor.x - contentX * next;
    view.current.y = next === 1 ? 0 : anchor.y - contentY * next;
    clampPan();
    applyView();
    syncCursor();
    publishZoomed(next > 1);
  };

  // Closing resets: the next photo starts unzoomed, and the shell hears about it.
  React.useEffect(() => {
    if (open) return;

    view.current = { scale: 1, x: 0, y: 0 };
    gesture.current = null;
    pointers.current.clear();
    zoomedRef.current = false;
    setZoomed(false);
  }, [open, setZoomed]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;

    if (box === null) return;

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()];

      if (first === undefined || second === undefined) return;

      const anchor = anchorOf((first.x + second.x) / 2, (first.y + second.y) / 2);

      if (anchor === null) return;

      const { scale, x, y } = view.current;

      // A pinch remembers the content point under its midpoint, and scaling keeps it there.
      gesture.current = {
        mode: "pinch",
        startDistance: Math.hypot(first.x - second.x, first.y - second.y),
        startScale: scale,
        contentX: (anchor.x - x) / scale,
        contentY: (anchor.y - y) / scale,
      };

      for (const pointerId of pointers.current.keys()) box.setPointerCapture(pointerId);

      return;
    }

    if (pointers.current.size > 2) return;

    // A single pointer pans only when there's something to pan.
    if (view.current.scale > 1) {
      gesture.current = {
        mode: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: view.current.x,
        originY: view.current.y,
      };

      box.setPointerCapture(event.pointerId);
      box.style.cursor = "grabbing";
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const current = gesture.current;

    if (current === null) return;

    if (current.mode === "pan") {
      if (event.pointerId !== current.pointerId) return;

      view.current.x = current.originX + event.clientX - current.startX;
      view.current.y = current.originY + event.clientY - current.startY;
      clampPan();
      applyView();

      return;
    }

    const [first, second] = [...pointers.current.values()];

    if (first === undefined || second === undefined) return;

    const next = Math.min(
      ZOOM_MAX,
      Math.max(
        1,
        (current.startScale * Math.hypot(first.x - second.x, first.y - second.y)) /
          current.startDistance,
      ),
    );

    const anchor = anchorOf((first.x + second.x) / 2, (first.y + second.y) / 2);

    if (anchor === null) return;

    view.current.scale = next;
    view.current.x = next === 1 ? 0 : anchor.x - current.contentX * next;
    view.current.y = next === 1 ? 0 : anchor.y - current.contentY * next;
    clampPan();
    applyView();
    syncCursor();
    publishZoomed(next > 1);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);

    const current = gesture.current;

    if (current === null) return;

    if (current.mode === "pinch") {
      // One finger lifting ends the pinch; the zoom it reached stays.
      if (pointers.current.size < 2) {
        gesture.current = null;
        syncCursor();
      }

      return;
    }

    if (event.pointerId === current.pointerId) {
      gesture.current = null;
      syncCursor();
    }
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    zoomAt(view.current.scale > 1 ? 1 : ZOOM_STEP, event.clientX, event.clientY);
  };

  return {
    boxRef,
    onPointerDown,
    onPointerMove,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
    onDoubleClick,
  };
}

/**
 * Browsers can't decode every image type, so a failed load shows `fallback` for that source. The
 * thumbnail holds the frame while the original decodes, and the photo itself owns zoom and pan.
 */
function LightboxImage({
  src,
  alt,
  fallback,
  placeholder,
}: {
  src: string;
  alt: string;
  fallback: React.ReactNode;
  placeholder?: string | null;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const [decoded, setDecoded] = React.useState(false);
  const zoom = useImageZoom();

  if (failedSrc === src) return fallback;

  const waiting = placeholder !== undefined && placeholder !== null;

  return (
    <div
      ref={zoom.boxRef}
      data-slot="lightbox-zoom"
      onPointerDown={zoom.onPointerDown}
      onPointerMove={zoom.onPointerMove}
      onPointerUp={zoom.onPointerUp}
      onPointerCancel={zoom.onPointerCancel}
      onDoubleClick={zoom.onDoubleClick}
      className="relative grid h-full w-full touch-none cursor-zoom-in place-items-center select-none"
    >
      {waiting ? (
        <img
          src={placeholder}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
      ) : null}
      <img
        src={src}
        alt={alt}
        data-slot="lightbox-media"
        decoding="async"
        draggable={false}
        onLoad={() => setDecoded(true)}
        onError={() => setFailedSrc(src)}
        className={cn(
          "relative z-10 max-h-full max-w-full object-contain transition-opacity duration-150 ease-(--ease-out)",
          decoded || !waiting ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function LightboxVideo({
  src,
  label,
  fallback,
}: {
  src: string;
  label: string;
  fallback: React.ReactNode;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);

  if (failedSrc === src) return fallback;

  // Personal media has no caption source in v1, so the file name is the accessible label.
  return (
    <video
      src={src}
      aria-label={label}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailedSrc(src)}
      className="max-h-full max-w-full"
    />
  );
}

function LightboxPending() {
  return <Spinner label="Loading preview" className="text-white/60" />;
}

function LightboxMessage({ title, action }: { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div role="alert" className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
      <p className="text-[13px] text-white/85">{title}</p>
      {action}
    </div>
  );
}

/** Feedback about an action, over the stage so the media stays visible behind it. */
function LightboxNotice({ title, action }: { title: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="absolute inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] mx-auto flex w-fit max-w-full items-center gap-3 rounded-lg bg-black/80 px-3 py-2 text-[13px] text-white ring-1 ring-white/15"
    >
      <p className="min-w-0 text-pretty">{title}</p>
      {action}
    </div>
  );
}

function LightboxAction({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" className={cn(lightboxControlClasses, className)} {...props} />;
}

export {
  Lightbox,
  LightboxAction,
  LightboxImage,
  LightboxMessage,
  LightboxNotice,
  LightboxPending,
  LightboxVideo,
};

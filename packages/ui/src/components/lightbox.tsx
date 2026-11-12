"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import * as React from "react";

const SWIPE_THRESHOLD_PX = 48;
const FLICK_MINIMUM_PX = 16;
const FLICK_PX_PER_MS = 0.11;

type SwipeStart = { readonly x: number; readonly y: number; readonly at: number };

/**
 * Full-screen viewer. Opening fades; moving between items is instant, because stepping through
 * photos with arrow keys is the most repeated action here and must never feel delayed.
 */
function Lightbox({
  open,
  onOpenChange,
  title,
  onPrevious,
  onNext,
  actions,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onPrevious?: () => void;
  onNext?: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const swipeStart = React.useRef<SwipeStart | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
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
          }}
        >
          <div className="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))]">
            <DialogPrimitive.Close aria-label="Close viewer" className={lightboxControlClasses}>
              <XIcon aria-hidden />
            </DialogPrimitive.Close>
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[13px] text-white/90">
              {title}
            </DialogPrimitive.Title>
            {actions}
          </div>
          <div
            role="none"
            className="relative grid min-h-0 flex-1 touch-pan-y place-items-center select-none"
            onPointerDown={(event) => {
              // A drag along a video's scrubber or across a control isn't a swipe between items.
              const started =
                event.target instanceof Element && event.target.closest("video,button,a") === null;

              swipeStart.current =
                event.pointerType !== "mouse" && event.isPrimary && started
                  ? { x: event.clientX, y: event.clientY, at: event.timeStamp }
                  : null;
            }}
            onPointerCancel={() => {
              swipeStart.current = null;
            }}
            onPointerUp={(event) => {
              const start = swipeStart.current;

              if (start === null || !event.isPrimary) return;
              swipeStart.current = null;
              const distance = event.clientX - start.x;
              const reach = Math.abs(distance);
              const elapsed = Math.max(event.timeStamp - start.at, 1);

              // Mostly vertical movement is the page's pan. A quick flick needs less distance.
              if (reach <= Math.abs(event.clientY - start.y)) return;

              const flicked = reach >= FLICK_MINIMUM_PX && reach / elapsed > FLICK_PX_PER_MS;

              if (reach < SWIPE_THRESHOLD_PX && !flicked) return;

              if (distance > 0) onPrevious?.();
              else onNext?.();
            }}
          >
            {children}
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
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const lightboxControlClasses =
  "grid size-8 shrink-0 place-items-center rounded-md text-white/85 outline-none transition-colors duration-100 hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white coarse:size-11 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]";

// These sit over the photo, so their own fill has to hold 3:1 against even a white one.
const lightboxStageControlClasses =
  "absolute size-10 bg-black/60 text-white ring-1 ring-white/25 hover:bg-black/75 coarse:size-11";

/** Browsers can't decode every image type, so a failed load shows `fallback` for that source. */
function LightboxImage({
  src,
  alt,
  fallback,
}: {
  src: string;
  alt: string;
  fallback: React.ReactNode;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);

  if (failedSrc === src) return fallback;

  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      draggable={false}
      onError={() => setFailedSrc(src)}
      className="max-h-full max-w-full object-contain"
    />
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

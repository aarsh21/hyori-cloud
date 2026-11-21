"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { usePreloadWhenIdle } from "@hyori-cloud/ui/hooks/use-preload-when-idle";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** The properties Base UI registers for drag offsets and release timing, with their initial values. */
const SWIPE_PROPERTIES = [
  { name: "--drawer-swipe-movement-x", syntax: "<length>", initialValue: "0px" },
  { name: "--drawer-swipe-movement-y", syntax: "<length>", initialValue: "0px" },
  { name: "--drawer-snap-point-offset", syntax: "<length>", initialValue: "0px" },
  { name: "--drawer-swipe-progress", syntax: "<number>", initialValue: "0" },
  { name: "--drawer-swipe-strength", syntax: "<number>", initialValue: "1" },
];

let swipePropertiesRegistered = false;

/**
 * Base UI registers these on a drawer's first open, and each registration restyles the whole page:
 * about 260 ms at 4× CPU, paid by the first tap. Registering them while idle moves that off the tap;
 * Base UI's own attempts then find them taken and change nothing.
 */
function registerSwipeProperties() {
  if (swipePropertiesRegistered || !("registerProperty" in CSS)) return;
  swipePropertiesRegistered = true;

  for (const property of SWIPE_PROPERTIES) {
    try {
      CSS.registerProperty({ ...property, inherits: false });
    } catch {
      // Already registered, by Base UI or another copy of this module.
    }
  }
}

function Drawer<Payload>({ ...props }: DrawerPrimitive.Root.Props<Payload>) {
  usePreloadWhenIdle(registerSwipeProperties);

  return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger<Payload>({ ...props }: DrawerPrimitive.Trigger.Props<Payload>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

/**
 * A bottom sheet. It follows the finger while dragged and dismisses on distance or a flick; the
 * backdrop fades with the drag. The popup runs 3rem past the bottom edge (the bleed) so an upward
 * pull never shows a gap. Under reduced motion it fades in place. `instant` skips motion for
 * keyboard opens and closes.
 */
function DrawerContent({
  className,
  children,
  instant = false,
  ...props
}: DrawerPrimitive.Popup.Props & { instant?: boolean }) {
  const popup = React.useRef<HTMLDivElement>(null);

  // A keyboard lands on the first action, as in a menu; a finger leaves no focus ring on one.
  function initialFocus(type: string) {
    if (type !== "keyboard") return true;

    return popup.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? true;
  }

  return (
    <DrawerPrimitive.Portal keepMounted>
      <DrawerPrimitive.Backdrop
        data-slot="drawer-backdrop"
        data-instant={instant ? "" : undefined}
        className="fixed inset-0 z-50 bg-overlay opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 ease-(--ease-drawer) data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*200ms)] starting:data-open:opacity-0 data-swiping:duration-0 data-instant:transition-none"
      />
      <DrawerPrimitive.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
        <DrawerPrimitive.Popup
          ref={popup}
          initialFocus={initialFocus}
          // Once closing, the sheet is on its way out: off the accessibility tree and out of reach, so
          // the dialog an action opens is the only one. Its items have already returned focus.
          render={(popupProps, state) => (
            <div {...popupProps} inert={!state.open} aria-hidden={state.open ? undefined : true} />
          )}
          data-slot="drawer-content"
          data-instant={instant ? "" : undefined}
          className={cn(
            "-mb-12 flex max-h-[calc(85dvh+3rem)] w-full max-w-lg flex-col overflow-y-auto overscroll-contain rounded-t-xl bg-popover pb-[calc(3rem+env(safe-area-inset-bottom,0px))] text-popover-foreground shadow-(--shadow-dialog) outline-none [transform:translateY(var(--drawer-swipe-movement-y))] transition-[transform,opacity] duration-300 ease-(--ease-drawer) data-ending-style:[transform:translateY(calc(100%-3rem+2px))] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*200ms)] starting:data-open:[transform:translateY(calc(100%-3rem+2px))] data-swiping:duration-0 data-swiping:select-none data-instant:transition-none motion-reduce:data-ending-style:opacity-0 motion-reduce:starting:data-open:opacity-0",
            className,
          )}
          {...props}
        >
          <div
            aria-hidden
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/15"
          />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-[15px] font-semibold tracking-[-0.008em]", className)}
      {...props}
    />
  );
}

const createDrawerHandle = DrawerPrimitive.createHandle;

export { createDrawerHandle, Drawer, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger };

export type DrawerHandle<Payload> = ReturnType<typeof createDrawerHandle<Payload>>;

export type DrawerChangeDetails = DrawerPrimitive.Root.ChangeEventDetails;

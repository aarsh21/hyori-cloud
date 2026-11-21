"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "@hyori-cloud/ui/lib/utils";

/**
 * A filtered list behind one input. The owner supplies `items`, `filteredItems` and the input
 * value: the server does the matching, so this never filters on its own. Root renders no element,
 * so layout classes go on whatever wraps it. `ComboboxEmpty` must stay mounted under the list (see
 * Base UI) — render its children, not the component, conditionally.
 */
function Combobox<Value, Item = Value>({
  ...props
}: Omit<ComboboxPrimitive.Root.Props<Value, false, Item>, "className">) {
  return <ComboboxPrimitive.Root data-slot="combobox" {...props} />;
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1 text-[13px] transition-[border-color,box-shadow,background-color] duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 coarse:h-11 coarse:text-base",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner className="isolate z-50 outline-none" sideOffset={sideOffset}>
        {/* Typing opens and closes this list, so it appears without motion. */}
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) ring-1 ring-foreground/8 outline-none",
            className,
          )}
          {...props}
        >
          <ComboboxPrimitive.List>{children}</ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground coarse:min-h-11",
        className,
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Item>
  );
}

/**
 * Announced only while the list is empty. Stays mounted: swap its children, never conditionally
 * render it, or screen readers lose the announcement.
 */
function ComboboxEmpty({ className, children, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-2 py-2 text-[13px] text-muted-foreground", className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Empty>
  );
}

/** Quietly announced results status for a list that loads behind a debounce. */
function ComboboxStatus({ className, children, ...props }: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      data-slot="combobox-status"
      className={cn("sr-only", className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Status>
  );
}

/**
 * Builds the collection `<Combobox items>` takes, deriving each item's selection value and label
 * (`createItems` in Base UI). With it, selection events carry the derived values, while the list
 * still renders the source items. Memoize it on its data.
 */
const createComboboxItems = ComboboxPrimitive.createItems;

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxStatus,
  createComboboxItems,
};

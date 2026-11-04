"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import * as React from "react";

function Select<Value>({ ...props }: SelectPrimitive.Root.Props<Value>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({
  className,
  children,
  placeholder,
  ...props
}: SelectPrimitive.Trigger.Props & { placeholder?: string }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-8 min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-card px-2.5 text-[13px] whitespace-nowrap shadow-(--shadow-control) transition-[background-color,border-color,box-shadow] duration-150 outline-none select-none hover:bg-accent focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 data-disabled:pointer-events-none data-disabled:opacity-50 data-popup-open:bg-accent coarse:h-10",
        className,
      )}
      {...props}
    >
      {children ?? <SelectPrimitive.Value placeholder={placeholder} />}
      <SelectPrimitive.Icon className="text-muted-foreground">
        <ChevronsUpDownIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  align = "start",
  sideOffset = 4,
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, "align" | "sideOffset">) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-(--shadow-popover) ring-1 ring-foreground/8 transition-[opacity,scale] duration-140 ease-(--ease-out) outline-none data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  description,
  ...props
}: SelectPrimitive.Item.Props & { description?: React.ReactNode }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative grid cursor-default grid-cols-[1fr_1rem] items-center gap-x-3 rounded-sm px-2 py-1.5 text-[13px] outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 truncate">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="col-start-2 row-start-1">
        <CheckIcon className="size-3.5" strokeWidth={2} aria-hidden />
      </SelectPrimitive.ItemIndicator>
      {description === undefined ? null : (
        <span className="col-span-2 max-w-64 pt-0.5 text-xs/snug text-muted-foreground">
          {description}
        </span>
      )}
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger };

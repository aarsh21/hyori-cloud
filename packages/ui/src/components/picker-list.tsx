import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** A bordered, scrollable list for choosing among folders inside dialogs. */
function PickerList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="picker-list"
      className={cn(
        "flex h-56 flex-col overflow-y-auto overscroll-contain rounded-lg border border-border p-1",
        className,
      )}
      {...props}
    />
  );
}

function PickerRow({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="picker-row"
      className={cn(
        "flex min-h-8 items-center gap-1 rounded-sm hover:bg-accent coarse:min-h-11",
        className,
      )}
      {...props}
    />
  );
}

function PickerRowButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 coarse:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]",
        className,
      )}
      {...props}
    />
  );
}

function PickerRowLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex min-h-8 min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-sm px-2 text-[13px] coarse:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]",
        className,
      )}
      {...props}
    />
  );
}

export { PickerList, PickerRow, PickerRowButton, PickerRowLabel };

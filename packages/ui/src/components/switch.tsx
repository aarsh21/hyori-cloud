"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@hyori-cloud/ui/lib/utils";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-input p-0.5 transition-colors duration-150 outline-none after:absolute after:-inset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="size-3.5 rounded-full bg-card shadow-(--shadow-control) transition-[translate] duration-150 ease-(--ease-out) data-checked:translate-x-3"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

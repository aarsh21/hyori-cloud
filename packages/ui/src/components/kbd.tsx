import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border bg-background px-1 font-sans text-[11px] font-medium text-muted-foreground coarse:hidden",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };

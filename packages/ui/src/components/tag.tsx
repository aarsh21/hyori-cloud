import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

function Tag({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tag"
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-[4px] bg-muted px-1.5 text-[11px] font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Tag };

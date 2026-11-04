"use client";

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@hyori-cloud/ui/lib/utils";

/** Transfer feedback. `value={null}` renders the indeterminate state for unknown progress. */
function Progress({
  className,
  value,
  label,
  tone = "default",
}: {
  className?: string;
  value: number | null;
  label: string;
  tone?: "default" | "destructive";
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      aria-label={label}
      className={cn("h-0.5 w-full overflow-hidden rounded-full bg-border", className)}
    >
      <ProgressPrimitive.Track className="h-full w-full">
        <ProgressPrimitive.Indicator
          style={{ width: "100%", translate: `${(value ?? 100) - 100}%` }}
          className={cn(
            "h-full rounded-full transition-[translate] duration-200 ease-linear data-indeterminate:opacity-40",
            tone === "destructive" ? "bg-destructive" : "bg-foreground/70",
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };

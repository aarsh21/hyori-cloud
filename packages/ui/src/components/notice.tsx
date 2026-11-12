import { cn } from "@hyori-cloud/ui/lib/utils";
import { CircleAlertIcon, WifiOffIcon } from "lucide-react";
import * as React from "react";

/**
 * Persistent inline feedback beside the affected content or action. Retained data stays mounted
 * around it; this is never a replacement for the region it reports on.
 */
function Notice({
  className,
  title,
  children,
  action,
  tone = "error",
}: {
  className?: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  tone?: "error" | "offline" | "info";
}) {
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      role={tone === "info" ? "status" : "alert"}
      className={cn(
        "flex flex-wrap items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-[13px]/snug data-[tone=error]:border-destructive/25 data-[tone=error]:bg-destructive/4",
        className,
      )}
    >
      {tone === "info" ? null : (
        <span
          className={cn(
            "mt-px shrink-0 [&_svg]:size-4 [&_svg]:stroke-[1.75]",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {tone === "error" ? <CircleAlertIcon aria-hidden /> : <WifiOffIcon aria-hidden />}
        </span>
      )}
      <div className="min-w-[min(12rem,70%)] flex-1 wrap-anywhere">
        <div className="font-medium text-pretty">{title}</div>
        {children === undefined ? null : (
          <div className="mt-0.5 text-pretty text-muted-foreground">{children}</div>
        )}
      </div>
      {action === undefined ? null : <div className="-my-0.5 shrink-0">{action}</div>}
    </div>
  );
}

export { Notice };

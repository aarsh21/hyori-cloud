import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** Transfers stay in a corner so browsing continues underneath; they are never a blocking dialog. */
function TransferTray({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="transfer-tray"
      className={cn(
        "fixed right-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 flex max-h-[min(24rem,60svh)] w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl bg-popover shadow-(--shadow-popover) ring-1 ring-foreground/8 transition-[translate,opacity] duration-200 ease-(--ease-out) starting:translate-y-2 starting:opacity-0 sm:w-[22rem] md:bottom-4 md:right-4",
        className,
      )}
      {...props}
    />
  );
}

function TransferTrayHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      className={cn("flex min-h-11 shrink-0 items-center gap-2 px-3.5 py-1.5", className)}
      {...props}
    />
  );
}

function TransferTrayTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      aria-live="polite"
      className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", className)}
      {...props}
    />
  );
}

function TransferList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="transfer-list"
      className={cn("flex min-h-0 flex-col overflow-y-auto border-t border-border py-1", className)}
      {...props}
    />
  );
}

function TransferItem({
  className,
  name,
  tag,
  detail,
  tone = "default",
  wrapDetail = tone === "destructive",
  progress,
  actions,
}: {
  className?: string;
  name: string;
  /** What kind of transfer this is, when that isn't an ordinary upload. */
  tag?: React.ReactNode;
  detail: React.ReactNode;
  tone?: "default" | "destructive";
  /** Progress stays on one line so it can't shift the row. A message has to be readable whole. */
  wrapDetail?: boolean;
  progress?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <li
      data-slot="transfer-item"
      className={cn("flex min-h-12 shrink-0 items-center gap-2 px-3.5 py-1.5", className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate text-[13px]" title={name}>
            {name}
          </p>
          {tag}
        </div>
        {progress}
        <p
          className={cn(
            "text-xs tabular-nums",
            wrapDetail ? "text-pretty wrap-anywhere" : "truncate",
            tone === "destructive" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      )}
    </li>
  );
}

export { TransferItem, TransferList, TransferTray, TransferTrayHeader, TransferTrayTitle };

import { cn } from "@hyori-cloud/ui/lib/utils";
import { ChevronsUpDownIcon } from "lucide-react";
import * as React from "react";

function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full bg-foreground/8 text-[11px] font-medium text-foreground",
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Rendered as a menu trigger, so it forwards every prop and ref the menu supplies. */
function AppAccountTrigger({
  name,
  detail,
  className,
  ...props
}: React.ComponentProps<"button"> & { name: string; detail: string }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none select-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-expanded:bg-sidebar-accent",
        className,
      )}
      {...props}
    >
      <Initial name={name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-sidebar-accent-foreground">
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">{detail}</span>
      </span>
      <ChevronsUpDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </button>
  );
}

function AppAccountNavTrigger({
  name,
  className,
  ...props
}: React.ComponentProps<"button"> & { name: string }) {
  return (
    <button
      type="button"
      aria-label="Account"
      className={cn(
        "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground outline-none select-none focus-visible:bg-sidebar-accent active:bg-sidebar-accent aria-expanded:text-foreground data-current:font-medium data-current:text-foreground",
        className,
      )}
      {...props}
    >
      <Initial name={name} className="size-5 text-[11px]" />
      <span className="truncate">Account</span>
    </button>
  );
}

function AppAccountSummary({ name, email, usage }: { name: string; email: string; usage: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="truncate font-medium text-foreground">{name}</span>
      <span className="truncate">{email}</span>
      <span className="mt-1 truncate tabular-nums">{usage}</span>
    </span>
  );
}

export { AppAccountNavTrigger, AppAccountSummary, AppAccountTrigger };

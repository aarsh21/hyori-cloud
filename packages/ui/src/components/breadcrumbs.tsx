import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import * as React from "react";

function Breadcrumbs({ className, children, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="breadcrumbs"
      aria-label="Folder path"
      className={cn("min-w-0 flex-1", className)}
      {...props}
    >
      <ol className="flex min-w-0 items-center gap-0.5">{children}</ol>
    </nav>
  );
}

function BreadcrumbLink({ className, ...props }: React.ComponentProps<typeof AppLink>) {
  return (
    <li className="flex min-w-0 shrink items-center gap-0.5">
      <AppLink
        className={cn(
          "max-w-40 truncate rounded-sm px-1 py-0.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:py-3",
          className,
        )}
        {...props}
      />
      <ChevronRightIcon
        aria-hidden
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
    </li>
  );
}

function BreadcrumbCurrent({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <li className="min-w-0 shrink-[0.2]">
      <h1
        aria-current="page"
        className={cn(
          "truncate px-1 py-0.5 text-lg font-semibold tracking-[-0.02em] text-foreground",
          className,
        )}
        {...props}
      />
    </li>
  );
}

export { BreadcrumbCurrent, BreadcrumbLink, Breadcrumbs };

"use client";

import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

function AppShell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell"
      className={cn(
        "flex h-svh flex-col overflow-hidden bg-sidebar pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-foreground max-md:pt-[env(safe-area-inset-top)] md:flex-row",
        className,
      )}
      {...props}
    />
  );
}

function AppSkipLink({ className, ...props }: React.ComponentProps<"a">) {
  return (
    <a
      data-slot="app-skip-link"
      className={cn(
        "fixed top-2 left-2 z-[60] -translate-y-16 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground outline-none focus-visible:translate-y-0 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    />
  );
}

function AppMain({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="app-main"
      tabIndex={-1}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card outline-none md:my-2 md:mr-2 md:rounded-2xl md:shadow-(--shadow-panel)",
        className,
      )}
      {...props}
    />
  );
}

function AppBottomNav({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="app-bottom-nav"
      className={cn(
        "flex shrink-0 items-stretch border-t border-border bg-sidebar pb-[env(safe-area-inset-bottom)] md:hidden",
        className,
      )}
      {...props}
    />
  );
}

function AppBottomNavItem({
  className,
  current = false,
  icon,
  children,
  ...props
}: React.ComponentProps<typeof AppLink> & { current?: boolean; icon: React.ReactNode }) {
  return (
    <AppLink
      data-slot="app-bottom-nav-item"
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground outline-none select-none focus-visible:bg-sidebar-accent active:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-5 [&_svg]:stroke-[1.75]",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
    </AppLink>
  );
}

/** One row at the top of a screen: location on the left, the screen's few real actions on the right. */
function PageBar({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-bar"
      className={cn(
        "flex min-h-13 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-3 py-2 md:px-4 md:group-data-[state=collapsed]/sidebar-wrapper:pl-11",
        className,
      )}
      {...props}
    />
  );
}

function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-title"
      className={cn("truncate text-lg font-semibold tracking-[-0.02em] text-foreground", className)}
      {...props}
    />
  );
}

function PageBarActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-bar-actions"
      className={cn("ml-auto flex shrink-0 items-center gap-1.5", className)}
      {...props}
    />
  );
}

/**
 * Scroll restoration keys scrollers by their DOM position, which is identical for every
 * screen's body, so without an identity one screen's leftover scroll lands on the next
 * screen once it mounts. A scrollRestorationId keys the body to its screen instead:
 * going back restores only the same screen's own position, and every navigation between
 * screens starts at the top.
 */
function PageBody({
  className,
  scrollRestorationId,
  ...props
}: React.ComponentProps<"div"> & { scrollRestorationId?: string }) {
  return (
    <div
      data-slot="page-body"
      data-scroll-restoration-id={scrollRestorationId}
      className={cn("relative min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  );
}

function PageSection({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-section"
      className={cn("flex min-h-full flex-col gap-3 p-2 md:p-3", className)}
      {...props}
    />
  );
}

export {
  AppBottomNav,
  AppBottomNavItem,
  AppMain,
  AppShell,
  AppSkipLink,
  PageBar,
  PageBarActions,
  PageBody,
  PageSection,
  PageTitle,
};

"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { AppMain, AppShell } from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { Kbd } from "@hyori-cloud/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hyori-cloud/ui/components/tooltip";
import { useDocumentKeydown } from "@hyori-cloud/ui/hooks/use-document-keydown";
import { useBrowserPreferencesReady } from "@hyori-cloud/ui/hooks/use-browser-preferences-ready";
import {
  readSidebarOpen,
  subscribeSidebarOpen,
  writeSidebarOpen,
} from "@hyori-cloud/ui/lib/sidebar-preference";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { PanelLeftIcon } from "lucide-react";
import * as React from "react";

const SIDEBAR_SHORTCUT_KEY = "b";

const SidebarOpenContext = React.createContext<boolean | null>(null);

function useSidebarOpen() {
  const open = React.use(SidebarOpenContext);

  if (open === null) throw new Error("Sidebar parts must be used within a SidebarProvider.");

  return open;
}

function toggleSidebar() {
  writeSidebarOpen(!readSidebarOpen());
}

function serverSidebarOpen() {
  return true;
}

function subscribeToNothing() {
  return () => {};
}

function clientShortcutModifier() {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
}

function serverShortcutModifier() {
  return "Ctrl+";
}

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Adapted from shadcn/ui's Base UI sidebar. Collapsing is immediate: it is frequent and has a
 * keyboard shortcut, and animating width would lay out long file lists on every frame. Phones
 * navigate with `AppBottomNav`, so there is no off-canvas sheet.
 */
function SidebarProvider({ className, children, ...props }: React.ComponentProps<"div">) {
  const open = React.useSyncExternalStore(subscribeSidebarOpen, readSidebarOpen, serverSidebarOpen);
  const ready = useBrowserPreferencesReady();

  useDocumentKeydown((event) => {
    if (event.key.toLowerCase() !== SIDEBAR_SHORTCUT_KEY) return;

    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;

    if (event.repeat || isEditing(event.target)) return;
    event.preventDefault();
    toggleSidebar();
  });

  return (
    <SidebarOpenContext value={open}>
      <AppShell
        data-slot="sidebar-wrapper"
        data-state={open ? "expanded" : "collapsed"}
        data-browser-ready={ready}
        className={cn("group/sidebar-wrapper", className)}
        {...props}
      >
        {children}
      </AppShell>
    </SidebarOpenContext>
  );
}

function Sidebar({ className, ...props }: React.ComponentProps<"aside">) {
  const open = useSidebarOpen();

  return (
    <aside
      data-slot="sidebar"
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "peer hidden h-svh w-56 shrink-0 flex-col text-sidebar-foreground md:data-[state=expanded]:flex",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One fixed element above the sidebar and the page, so the control keeps its exact position and
 * keyboard focus in both states. Its icon lines up with the navigation icons, and its row with the
 * page bar's. `SidebarHeader` and `PageBar` leave it room.
 */
function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const open = useSidebarOpen();

  const modifier = React.useSyncExternalStore(
    subscribeToNothing,
    clientShortcutModifier,
    serverShortcutModifier,
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-slot="sidebar-trigger"
            variant="ghost"
            size="icon-sm"
            aria-label="Sidebar"
            aria-expanded={open}
            aria-keyshortcuts="Control+B Meta+B"
            className={cn(
              // The sidebar being open shows for itself, so its toggle doesn't stay filled like an open menu.
              "fixed top-5 left-[calc(0.75rem+env(safe-area-inset-left))] z-20 hidden not-hover:aria-expanded:bg-transparent not-hover:aria-expanded:text-muted-foreground after:absolute after:-inset-[9px] coarse:size-7 md:inline-flex",
              className,
            )}
            onClick={(event) => {
              onClick?.(event);
              toggleSidebar();
            }}
            {...props}
          />
        }
      >
        <PanelLeftIcon aria-hidden strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {open ? "Hide sidebar" : "Show sidebar"}
        <Kbd>
          {modifier}
          {SIDEBAR_SHORTCUT_KEY.toUpperCase()}
        </Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<typeof AppMain>) {
  return (
    <AppMain
      data-slot="sidebar-inset"
      className={cn("md:peer-data-[state=collapsed]:ml-2", className)}
      {...props}
    />
  );
}

/** The left padding starts the content on the navigation labels, clear of `SidebarTrigger`. */
function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex h-15 shrink-0 items-center pt-2 pr-2.5 pl-11", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2.5", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex shrink-0 flex-col gap-2 px-2.5 pt-2 pb-3", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" className={cn("flex flex-col", className)} {...props} />;
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn("px-2 pb-1 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function SidebarNav(props: React.ComponentProps<"nav">) {
  return <nav data-slot="sidebar-nav" {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul data-slot="sidebar-menu" className={cn("flex flex-col gap-0.5", className)} {...props} />
  );
}

function SidebarMenuItem(props: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" {...props} />;
}

function SidebarMenuButton({
  render,
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"button"> & { isActive?: boolean }) {
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        className: cn(
          "flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground outline-none select-none hover:bg-sidebar-accent active:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
          className,
        ),
      },
      props,
    ),
    state: { slot: "sidebar-menu-button", active: isActive },
  });
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNav,
  SidebarProvider,
  SidebarTrigger,
};

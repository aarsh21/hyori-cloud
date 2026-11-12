"use client";

import { AppMain, AppShell } from "@hyori-cloud/ui/components/app-shell";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { useBrowserPreferencesReady } from "@hyori-cloud/ui/hooks/use-browser-preferences-ready";
import { readSidebarOpen, subscribeSidebarOpen } from "@hyori-cloud/ui/lib/sidebar-preference";
import { useSyncExternalStore } from "react";

function serverSidebarOpen() {
  return true;
}

/** The frame in its real proportions while the signed-in app's code arrives, so nothing moves after. */
export function AppShellFallback() {
  const open = useSyncExternalStore(subscribeSidebarOpen, readSidebarOpen, serverSidebarOpen);
  const ready = useBrowserPreferencesReady();

  return (
    <AppShell data-browser-ready={ready}>
      {open ? (
        <div aria-hidden className="hidden h-svh w-56 shrink-0 md:block">
          <div className="flex h-15 items-center pt-2 pr-2.5 pl-11">
            <Wordmark />
          </div>
        </div>
      ) : null}
      <AppMain className={open ? undefined : "md:ml-2"} />
      <div
        aria-hidden
        className="h-[calc(3.5rem+env(safe-area-inset-bottom))] shrink-0 border-t border-border md:hidden"
      />
    </AppShell>
  );
}

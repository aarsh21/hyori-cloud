import type { ReactNode } from "@hyori-cloud/lib/react";
import { Suspense } from "@hyori-cloud/lib/react";
import { AppSkipLink } from "@hyori-cloud/ui/components/app-shell";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@hyori-cloud/ui/components/sidebar";
import { CloudBottomNav } from "#features/cloud/react/cloud-bottom-nav.tsx";
import { CloudSidebar } from "#features/cloud/react/cloud-sidebar.tsx";
import { lazyScreen, loadUploadTray } from "#features/cloud/react/cloud-screen-loaders.ts";

// Nothing renders until an upload starts, and its chunk is warmed by the idle preload, so the
// tray never costs the first paint anything and still appears at once when work begins.
const UploadTray = lazyScreen(loadUploadTray, (module) => module.UploadTray);

export function CloudShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSkipLink href="#main">Skip to content</AppSkipLink>
      <SidebarTrigger />
      <CloudSidebar />
      <SidebarInset id="main">
        {children}
        <Suspense fallback={null}>
          <UploadTray />
        </Suspense>
      </SidebarInset>
      <CloudBottomNav />
    </SidebarProvider>
  );
}

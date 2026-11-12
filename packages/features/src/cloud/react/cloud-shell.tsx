import type { ReactNode } from "@hyori-cloud/lib/react";
import { AppSkipLink } from "@hyori-cloud/ui/components/app-shell";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@hyori-cloud/ui/components/sidebar";
import { CloudBottomNav } from "#features/cloud/react/cloud-bottom-nav.tsx";
import { CloudSidebar } from "#features/cloud/react/cloud-sidebar.tsx";
import { UploadTray } from "#features/uploads/react/upload-tray.tsx";

export function CloudShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSkipLink href="#main">Skip to content</AppSkipLink>
      <SidebarTrigger />
      <CloudSidebar />
      <SidebarInset id="main">
        {children}
        <UploadTray />
      </SidebarInset>
      <CloudBottomNav />
    </SidebarProvider>
  );
}

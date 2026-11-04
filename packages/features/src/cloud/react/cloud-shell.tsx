import type { ReactNode } from "@hyori-cloud/lib/react";
import { AppMain, AppShell, AppSkipLink } from "@hyori-cloud/ui/components/app-shell";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { CloudBottomNav } from "#features/cloud/react/cloud-bottom-nav.tsx";
import { CloudSidebar } from "#features/cloud/react/cloud-sidebar.tsx";
import { UploadTray } from "#features/uploads/react/upload-tray.tsx";
import { UploadsProvider } from "#features/uploads/react/uploads-provider.tsx";

export function CloudShell({ children }: { children: ReactNode }) {
  const user = useCurrentUser();

  return (
    // Interrupted uploads belong to one account. Changing accounts must not carry them across.
    <UploadsProvider key={user.id} scope={user.id}>
      <AppShell>
        <AppSkipLink href="#main">Skip to content</AppSkipLink>
        <CloudSidebar />
        <AppMain id="main">{children}</AppMain>
        <CloudBottomNav />
        <UploadTray />
      </AppShell>
    </UploadsProvider>
  );
}

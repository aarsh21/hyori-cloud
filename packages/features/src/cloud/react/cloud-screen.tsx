import { Suspense } from "@hyori-cloud/lib/react";
import { AppShellFallback } from "@hyori-cloud/ui/components/app-shell-fallback";
import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { AuthBoundary } from "#features/auth/react/auth-boundary.tsx";
import { parseCloudPath } from "#features/cloud/cloud-path.ts";
import {
  CloudNavigationProvider,
  useCloudNavigation,
} from "#features/cloud/react/cloud-navigation.tsx";
import { FocusFallback } from "#features/cloud/react/focus-fallback.tsx";
import type { NavigationGuard } from "#features/cloud/navigation-guard.ts";
import {
  lazyScreen,
  loadCloudShell,
  loadInviteScreen,
  loadPublicShareScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";

const SignedInCloud = lazyScreen(loadCloudShell, (module) => module.SignedInCloud);
const InviteScreen = lazyScreen(loadInviteScreen, (module) => module.InviteScreen);
const PublicShareScreen = lazyScreen(loadPublicShareScreen, (module) => module.PublicShareScreen);

/**
 * The whole product surface. The host owns the router and supplies only the current path and a
 * way to change it, so every location is a real URL with working back, reload, and new-tab.
 */
export function CloudScreen({
  path,
  onNavigate,
  navigationGuard,
}: {
  path: string;
  onNavigate: (path: string) => void;
  /** Screens with unsaved work hold this, for the host to warn before leaving. */
  navigationGuard?: NavigationGuard;
}) {
  const location = parseCloudPath(path);

  return (
    <CloudNavigationProvider
      location={location}
      onNavigate={onNavigate}
      navigationGuard={navigationGuard}
    >
      <TooltipProvider>
        <CloudLocationScreen />
      </TooltipProvider>
    </CloudNavigationProvider>
  );
}

function CloudLocationScreen() {
  const { location } = useCloudNavigation();

  if (location.section === "invite") {
    return (
      <Suspense fallback={<FocusFallback />}>
        <InviteScreen token={location.token} />
      </Suspense>
    );
  }

  // One screen for a link's folders and its editor, so moving between them keeps the opened grant.
  if (location.section === "publicShare" || location.section === "publicEditor") {
    return (
      <Suspense fallback={<FocusFallback />}>
        <PublicShareScreen
          key={location.token}
          token={location.token}
          folderId={location.section === "publicShare" ? location.folderId : null}
          editingFileId={location.section === "publicEditor" ? location.fileId : null}
        />
      </Suspense>
    );
  }

  return (
    <AuthBoundary>
      {/* The editor and the file manager share one signed-in owner, which keeps uploads running. */}
      <Suspense fallback={location.section === "editor" ? <FocusFallback /> : <AppShellFallback />}>
        <SignedInCloud location={location} />
      </Suspense>
    </AuthBoundary>
  );
}

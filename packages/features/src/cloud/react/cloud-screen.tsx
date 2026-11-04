import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { AuthBoundary } from "#features/auth/react/auth-boundary.tsx";
import { InviteScreen } from "#features/auth/react/invite-screen.tsx";
import { parseCloudPath } from "#features/cloud/cloud-path.ts";
import { CloudContent } from "#features/cloud/react/cloud-content.tsx";
import {
  CloudNavigationProvider,
  useCloudNavigation,
} from "#features/cloud/react/cloud-navigation.tsx";
import { CloudShell } from "#features/cloud/react/cloud-shell.tsx";
import { PublicShareScreen } from "#features/sharing/react/public-share-screen.tsx";

/**
 * The whole product surface. The host owns the router and supplies only the current path and a
 * way to change it, so every location is a real URL with working back, reload, and new-tab.
 */
export function CloudScreen({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const location = parseCloudPath(path);

  return (
    <CloudNavigationProvider location={location} onNavigate={onNavigate}>
      <TooltipProvider>
        <CloudLocationScreen />
      </TooltipProvider>
    </CloudNavigationProvider>
  );
}

function CloudLocationScreen() {
  const { location } = useCloudNavigation();

  if (location.section === "invite") return <InviteScreen token={location.token} />;

  if (location.section === "publicShare") {
    return (
      <PublicShareScreen key={location.token} token={location.token} folderId={location.folderId} />
    );
  }

  return (
    <AuthBoundary>
      <CloudShell>
        <CloudContent location={location} />
      </CloudShell>
    </AuthBoundary>
  );
}

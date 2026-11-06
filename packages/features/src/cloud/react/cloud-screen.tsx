import { lazy, Suspense } from "@hyori-cloud/lib/react";
import { AppShellFallback } from "@hyori-cloud/ui/components/app-shell-fallback";
import { FocusLayout } from "@hyori-cloud/ui/components/focus-layout";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Row } from "@hyori-cloud/ui/components/text";
import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { AuthBoundary } from "#features/auth/react/auth-boundary.tsx";
import { formatCloudPath, parseCloudPath } from "#features/cloud/cloud-path.ts";
import {
  CloudNavigationProvider,
  useCloudNavigation,
} from "#features/cloud/react/cloud-navigation.tsx";
import type { NavigationGuard } from "#features/cloud/navigation-guard.ts";
import {
  loadCloudShell,
  loadEditorScreen,
  loadInviteScreen,
  loadPublicShareScreen,
} from "#features/cloud/react/cloud-screen-loaders.ts";

const SignedInCloud = lazy(async () => ({ default: (await loadCloudShell()).SignedInCloud }));
const InviteScreen = lazy(async () => ({ default: (await loadInviteScreen()).InviteScreen }));
const EditorScreen = lazy(async () => ({ default: (await loadEditorScreen()).EditorScreen }));

const PublicShareScreen = lazy(async () => ({
  default: (await loadPublicShareScreen()).PublicShareScreen,
}));

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

const ACCOUNT_DESTINATION = { kind: "folder", folderId: null } as const;

function filesFolderPath(parentId: string | null) {
  return formatCloudPath({ section: "files", folderId: parentId });
}

function FocusFallback() {
  return (
    <FocusLayout>
      <Wordmark />
      <Row className="min-h-9">
        <Spinner />
      </Row>
    </FocusLayout>
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

  if (location.section === "editor") {
    return (
      <AuthBoundary>
        <Suspense fallback={<FocusFallback />}>
          <EditorScreen
            key={location.fileId}
            fileId={location.fileId}
            copyDestination={ACCOUNT_DESTINATION}
            closePath={filesFolderPath}
          />
        </Suspense>
      </AuthBoundary>
    );
  }

  return (
    <AuthBoundary>
      <Suspense fallback={<AppShellFallback />}>
        <SignedInCloud location={location} />
      </Suspense>
    </AuthBoundary>
  );
}

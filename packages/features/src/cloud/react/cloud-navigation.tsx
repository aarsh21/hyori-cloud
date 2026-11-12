import { createContext, useContext } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { focusMainRegion } from "@hyori-cloud/ui/lib/browser";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";
import { createNavigationGuard } from "#features/cloud/navigation-guard.ts";
import type { NavigationGuard } from "#features/cloud/navigation-guard.ts";

type CloudNavigation = {
  readonly location: CloudLocation;
  /** Takes an app path, which is what DS links hand back. Moves focus so keyboard users keep their place. */
  readonly navigatePath: (path: string) => void;
  readonly navigationGuard: NavigationGuard;
};

// A host with nothing to warn through still gets a working guard, which simply goes unread.
const UNREAD_GUARD = createNavigationGuard();

const CloudNavigationContext = createContext<CloudNavigation | null>(null);

export function CloudNavigationProvider({
  location,
  onNavigate,
  navigationGuard = UNREAD_GUARD,
  children,
}: {
  location: CloudLocation;
  onNavigate: (path: string) => void;
  navigationGuard?: NavigationGuard | undefined;
  children: ReactNode;
}) {
  function navigatePath(path: string) {
    onNavigate(path);
    focusMainRegion();
  }

  return (
    <CloudNavigationContext value={{ location, navigatePath, navigationGuard }}>
      {children}
    </CloudNavigationContext>
  );
}

export function useCloudNavigation() {
  const navigation = useContext(CloudNavigationContext);

  if (navigation === null) throw new Error("useCloudNavigation requires CloudNavigationProvider.");

  return navigation;
}

export function useNavigateTo() {
  const { navigatePath } = useCloudNavigation();

  return (location: CloudLocation) => navigatePath(formatCloudPath(location));
}

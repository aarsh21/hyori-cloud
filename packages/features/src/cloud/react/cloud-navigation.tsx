import { createContext, use } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { focusMainRegion } from "@hyori-cloud/ui/lib/browser";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import type { CloudLocation } from "#features/cloud/cloud-path.ts";

type CloudNavigation = {
  readonly location: CloudLocation;
  /** Takes an app path, which is what DS links hand back. Moves focus so keyboard users keep their place. */
  readonly navigatePath: (path: string) => void;
};

const CloudNavigationContext = createContext<CloudNavigation | null>(null);

export function CloudNavigationProvider({
  location,
  onNavigate,
  children,
}: {
  location: CloudLocation;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  function navigatePath(path: string) {
    onNavigate(path);
    focusMainRegion();
  }

  return (
    <CloudNavigationContext value={{ location, navigatePath }}>{children}</CloudNavigationContext>
  );
}

export function useCloudNavigation() {
  const navigation = use(CloudNavigationContext);

  if (navigation === null) throw new Error("useCloudNavigation requires CloudNavigationProvider.");

  return navigation;
}

export function useNavigateTo() {
  const { navigatePath } = useCloudNavigation();

  return (location: CloudLocation) => navigatePath(formatCloudPath(location));
}

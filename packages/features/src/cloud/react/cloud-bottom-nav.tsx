import { AppBottomNav, AppBottomNavItem } from "@hyori-cloud/ui/components/app-shell";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { AccountMenuCompact } from "#features/cloud/react/account-menu-compact.tsx";
import { useCloudDataPrefetch } from "#features/cloud/react/cloud-data-prefetch.ts";
import { preloadCloudLocation } from "#features/cloud/react/cloud-screen-loaders.ts";
import { CLOUD_SECTIONS } from "#features/cloud/react/cloud-sections.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

export function CloudBottomNav() {
  const { location, navigatePath } = useCloudNavigation();
  const prefetchData = useCloudDataPrefetch();

  return (
    <AppBottomNav aria-label="Main">
      {CLOUD_SECTIONS.map((section) => (
        <AppBottomNavItem
          key={section.label}
          href={formatCloudPath(section.location)}
          onNavigate={navigatePath}
          onPointerDown={() => {
            preloadCloudLocation(section.location);
            prefetchData(section.location);
          }}
          onFocus={() => {
            preloadCloudLocation(section.location);
            prefetchData(section.location);
          }}
          current={section.isCurrent(location)}
          icon={<section.icon />}
        >
          {section.label}
        </AppBottomNavItem>
      ))}
      <AccountMenuCompact />
    </AppBottomNav>
  );
}

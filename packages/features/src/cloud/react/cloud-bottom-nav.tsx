import { AppBottomNav, AppBottomNavItem } from "@hyori-cloud/ui/components/app-shell";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { AccountMenuCompact } from "#features/cloud/react/account-menu-compact.tsx";
import { CLOUD_SECTIONS } from "#features/cloud/react/cloud-sections.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

export function CloudBottomNav() {
  const { location, navigatePath } = useCloudNavigation();

  return (
    <AppBottomNav aria-label="Main">
      {CLOUD_SECTIONS.map((section) => (
        <AppBottomNavItem
          key={section.label}
          href={formatCloudPath(section.location)}
          onNavigate={navigatePath}
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

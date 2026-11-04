import { Users } from "@hyori-cloud/lib/icons";
import {
  AppNavItem,
  AppSidebar,
  AppSidebarBrand,
  AppSidebarFooter,
  AppSidebarGroupLabel,
  AppSidebarNav,
} from "@hyori-cloud/ui/components/app-shell";
import { Stack } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { AccountMenu } from "#features/cloud/react/account-menu.tsx";
import { CLOUD_SECTIONS } from "#features/cloud/react/cloud-sections.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

export function CloudSidebar() {
  const { location, navigatePath } = useCloudNavigation();
  const user = useCurrentUser();

  return (
    <AppSidebar aria-label="Sidebar">
      <AppSidebarBrand>
        <Wordmark />
      </AppSidebarBrand>
      <AppSidebarNav aria-label="Main">
        {CLOUD_SECTIONS.map((section) => (
          <AppNavItem
            key={section.label}
            href={formatCloudPath(section.location)}
            onNavigate={navigatePath}
            current={section.isCurrent(location)}
            icon={<section.icon />}
          >
            {section.label}
          </AppNavItem>
        ))}
      </AppSidebarNav>
      {user.role === "admin" ? (
        <Stack>
          <AppSidebarGroupLabel>Server</AppSidebarGroupLabel>
          <AppSidebarNav aria-label="Server administration">
            <AppNavItem
              href={formatCloudPath({ section: "admin" })}
              onNavigate={navigatePath}
              current={location.section === "admin"}
              icon={<Users />}
            >
              Users
            </AppNavItem>
          </AppSidebarNav>
        </Stack>
      ) : null}
      <AppSidebarFooter>
        <AccountMenu />
      </AppSidebarFooter>
    </AppSidebar>
  );
}

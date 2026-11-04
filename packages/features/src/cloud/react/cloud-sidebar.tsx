import { Users } from "@hyori-cloud/lib/icons";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { AppLink } from "@hyori-cloud/ui/components/app-link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNav,
} from "@hyori-cloud/ui/components/sidebar";
import { InlineText } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { formatCloudPath, type CloudLocation } from "#features/cloud/cloud-path.ts";
import { AccountMenu } from "#features/cloud/react/account-menu.tsx";
import { CLOUD_SECTIONS } from "#features/cloud/react/cloud-sections.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

function CloudNavItem({
  destination,
  current,
  icon,
  children,
}: {
  destination: CloudLocation;
  current: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  const { navigatePath } = useCloudNavigation();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current}
        render={
          <AppLink
            href={formatCloudPath(destination)}
            onNavigate={navigatePath}
            aria-current={current ? "page" : undefined}
          />
        }
      >
        {icon}
        <InlineText size="md" truncate className="text-current">
          {children}
        </InlineText>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function CloudSidebar() {
  const { location } = useCloudNavigation();
  const user = useCurrentUser();

  return (
    <Sidebar aria-label="Sidebar">
      <SidebarHeader>
        <Wordmark />
      </SidebarHeader>
      <SidebarContent>
        <SidebarNav aria-label="Main">
          <SidebarMenu>
            {CLOUD_SECTIONS.map((section) => (
              <CloudNavItem
                key={section.label}
                destination={section.location}
                current={section.isCurrent(location)}
                icon={<section.icon />}
              >
                {section.label}
              </CloudNavItem>
            ))}
          </SidebarMenu>
        </SidebarNav>
        {user.role === "admin" ? (
          <SidebarGroup>
            <SidebarGroupLabel>Server</SidebarGroupLabel>
            <SidebarNav aria-label="Server administration">
              <SidebarMenu>
                <CloudNavItem
                  destination={{ section: "admin" }}
                  current={location.section === "admin"}
                  icon={<Users />}
                >
                  Users
                </CloudNavItem>
              </SidebarMenu>
            </SidebarNav>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

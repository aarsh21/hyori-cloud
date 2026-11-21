import { Trash2 } from "@hyori-cloud/lib/icons";
import { AppAccountNavTrigger } from "@hyori-cloud/ui/components/app-account";
import { DropdownMenuItem, DropdownMenuSeparator } from "@hyori-cloud/ui/components/dropdown-menu";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { AccountMenuRoot } from "#features/cloud/react/account-menu-root.tsx";
import { preloadCloudLocation } from "#features/cloud/react/cloud-screen-loaders.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";

export function AccountMenuCompact() {
  const user = useCurrentUser();
  const { location, navigatePath } = useCloudNavigation();

  return (
    <AccountMenuRoot
      align="end"
      trigger={
        // Trash has no tab here, so the tab that leads to it reads as current.
        <AppAccountNavTrigger
          name={user.name}
          data-current={location.section === "trash" ? "" : undefined}
        />
      }
    >
      <DropdownMenuItem
        onPointerDown={() => preloadCloudLocation({ section: "trash" })}
        onClick={() => navigatePath(formatCloudPath({ section: "trash" }))}
      >
        <Trash2 />
        Trash
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </AccountMenuRoot>
  );
}

import { KeyRound, Link2, LogOut, Users } from "@hyori-cloud/lib/icons";
import { AppAccountSummary } from "@hyori-cloud/ui/components/app-account";
import { AppearanceMenuItems } from "@hyori-cloud/ui/components/appearance-menu-items";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { ShortcutPreferenceMenuItems } from "@hyori-cloud/ui/components/shortcut-preference-menu-items";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { formatUsage } from "#features/shared/format.ts";

/** The menu closes on selection, so anything that outlives a click is owned by AccountMenuRoot. */
export function AccountMenuItems({
  signingOut,
  onShowAccountId,
  onChangePassword,
  onSignOut,
}: {
  signingOut: boolean;
  onShowAccountId: () => void;
  onChangePassword: () => void;
  onSignOut: () => void;
}) {
  const user = useCurrentUser();
  const navigateTo = useNavigateTo();

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          <AppAccountSummary
            name={user.name}
            email={user.email}
            usage={formatUsage(user.usedBytes, user.quotaBytes)}
          />
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onShowAccountId}>
        <Link2 />
        Your account ID
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onChangePassword}>
        <KeyRound />
        Change password…
      </DropdownMenuItem>
      {user.role === "admin" ? (
        <DropdownMenuItem onClick={() => navigateTo({ section: "admin" })} className="md:hidden">
          <Users />
          Users
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <AppearanceMenuItems />
      <ShortcutPreferenceMenuItems />
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onSignOut} disabled={signingOut}>
        <LogOut />
        Sign out
      </DropdownMenuItem>
    </>
  );
}

import { AppAccountTrigger } from "@hyori-cloud/ui/components/app-account";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { AccountMenuRoot } from "#features/cloud/react/account-menu-root.tsx";
import { formatUsage } from "#features/shared/format.ts";

export function AccountMenu() {
  const user = useCurrentUser();

  return (
    <AccountMenuRoot
      align="start"
      className="w-(--anchor-width)"
      trigger={
        <AppAccountTrigger name={user.name} detail={formatUsage(user.usedBytes, user.quotaBytes)} />
      }
    />
  );
}

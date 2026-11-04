import { AppAccountNavTrigger } from "@hyori-cloud/ui/components/app-account";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { AccountMenuRoot } from "#features/cloud/react/account-menu-root.tsx";

export function AccountMenuCompact() {
  const user = useCurrentUser();

  return <AccountMenuRoot align="end" trigger={<AppAccountNavTrigger name={user.name} />} />;
}

import { useState } from "@hyori-cloud/lib/react";
import type { ComponentProps, ReactElement } from "@hyori-cloud/lib/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { ChangePasswordDialog } from "#features/auth/react/change-password-dialog.tsx";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { useLogout } from "#features/auth/react/use-logout.ts";
import { AccountIdDialog } from "#features/cloud/react/account-id-dialog.tsx";
import { AccountMenuItems } from "#features/cloud/react/account-menu-items.tsx";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { PendingUploadsDialog } from "#features/uploads/react/pending-uploads-dialog.tsx";

type MenuContentProps = ComponentProps<typeof DropdownMenuContent>;

/**
 * Owns what outlives the menu. A failed sign-out stays up until dismissed, because on a shared
 * computer someone walking away must not assume they were signed out.
 */
export function AccountMenuRoot({
  trigger,
  align,
  className,
}: {
  trigger: ReactElement;
  align: MenuContentProps["align"];
  className?: string;
}) {
  const user = useCurrentUser();
  const logout = useLogout();
  const [accountIdOpen, setAccountIdOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [pendingUploadsOpen, setPendingUploadsOpen] = useState(false);

  function signOut() {
    logout.mutate(
      {},
      {
        onError(error) {
          const copy = describeCloudError(error);

          toast.error("You’re still signed in", {
            description: copy.detail ?? copy.title,
            duration: Infinity,
            closeButton: true,
            action: { label: "Try again", onClick: signOut },
          });
        },
      },
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent side="top" align={align} className={className}>
          <AccountMenuItems
            signingOut={logout.isPending}
            onShowAccountId={() => setAccountIdOpen(true)}
            onChangePassword={() => setChangePasswordOpen(true)}
            onShowPendingUploads={() => setPendingUploadsOpen(true)}
            onSignOut={signOut}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <AccountIdDialog accountId={user.id} open={accountIdOpen} onOpenChange={setAccountIdOpen} />
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
      <PendingUploadsDialog open={pendingUploadsOpen} onOpenChange={setPendingUploadsOpen} />
    </>
  );
}

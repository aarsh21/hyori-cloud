import { useState } from "@hyori-cloud/lib/react";
import type { ComponentProps, ReactElement } from "@hyori-cloud/lib/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { DeferredDialog } from "@hyori-cloud/ui/components/deferred-dialog";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { useLogout } from "#features/auth/react/use-logout.ts";
import { AccountMenuItems } from "#features/cloud/react/account-menu-items.tsx";
import { describeCloudError } from "#features/shared/cloud-error.ts";

const loadPassword = async () =>
  (await import("#features/auth/react/change-password-dialog.tsx")).ChangePasswordDialog;

const loadAccountId = async () =>
  (await import("#features/cloud/react/account-id-dialog.tsx")).AccountIdDialog;

const loadPendingUploads = async () =>
  (await import("#features/uploads/react/pending-uploads-dialog.tsx")).PendingUploadsDialog;

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
  // Unopened dialogs load nothing. Once opened, retain their normal closing/focus lifecycle.
  const [accountIdOpen, setAccountIdOpen] = useState<boolean>();
  const [changePasswordOpen, setChangePasswordOpen] = useState<boolean>();
  const [pendingUploadsOpen, setPendingUploadsOpen] = useState<boolean>();

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
        <DropdownMenuContent
          side="top"
          align={align}
          className={`${className ?? ""} animate-none! duration-0!`}
        >
          <AccountMenuItems
            signingOut={logout.isPending}
            onShowAccountId={() => setAccountIdOpen(true)}
            onChangePassword={() => setChangePasswordOpen(true)}
            onShowPendingUploads={() => setPendingUploadsOpen(true)}
            onSignOut={signOut}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {accountIdOpen !== undefined ? (
        <DeferredDialog
          load={loadAccountId}
          title="Account ID"
          open={accountIdOpen}
          onClose={() => setAccountIdOpen(false)}
          props={{ accountId: user.id, open: accountIdOpen, onOpenChange: setAccountIdOpen }}
        />
      ) : null}
      {changePasswordOpen !== undefined ? (
        <DeferredDialog
          load={loadPassword}
          title="Change password"
          open={changePasswordOpen}
          onClose={() => setChangePasswordOpen(false)}
          props={{ open: changePasswordOpen, onOpenChange: setChangePasswordOpen }}
        />
      ) : null}
      {pendingUploadsOpen !== undefined ? (
        <DeferredDialog
          load={loadPendingUploads}
          title="Unfinished uploads"
          open={pendingUploadsOpen}
          onClose={() => setPendingUploadsOpen(false)}
          props={{ open: pendingUploadsOpen, onOpenChange: setPendingUploadsOpen }}
        />
      ) : null}
    </>
  );
}

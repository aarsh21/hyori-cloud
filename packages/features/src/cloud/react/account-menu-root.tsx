import { useState } from "@hyori-cloud/lib/react";
import type { ComponentProps, ReactElement, ReactNode } from "@hyori-cloud/lib/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { DeferredDialog } from "@hyori-cloud/ui/components/deferred-dialog";
import { useLogout } from "#features/auth/react/use-logout.ts";
import { AccountMenuItems } from "#features/cloud/react/account-menu-items.tsx";
import { describeCloudError } from "#features/shared/cloud-error.ts";

const loadPassword = async () =>
  (await import("#features/auth/react/change-password-dialog.tsx")).ChangePasswordDialog;

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
  children,
}: {
  trigger: ReactElement;
  align: MenuContentProps["align"];
  className?: string;
  /** Places that have no tab of their own on phones. */
  children?: ReactNode;
}) {
  const logout = useLogout();
  // Unopened dialogs load nothing. Once opened, retain their normal closing/focus lifecycle.
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
      <DropdownMenu sheet>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent
          title="Account"
          side="top"
          align={align}
          className={`${className ?? ""} transition-none`}
        >
          {children}
          <AccountMenuItems
            signingOut={logout.isPending}
            onChangePassword={() => setChangePasswordOpen(true)}
            onShowPendingUploads={() => setPendingUploadsOpen(true)}
            onSignOut={signOut}
          />
        </DropdownMenuContent>
      </DropdownMenu>
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

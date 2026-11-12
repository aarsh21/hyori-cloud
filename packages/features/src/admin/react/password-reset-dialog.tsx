import { Button } from "@hyori-cloud/ui/components/button";
import { LinkField } from "@hyori-cloud/ui/components/copy-button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { FieldDescription } from "@hyori-cloud/ui/components/field";
import type { AdminUser } from "#features/admin/react/admin-screen.tsx";
import { describeResetLinkError } from "#features/auth/password-copy.ts";
import { useCreatePasswordReset } from "#features/auth/react/use-password.ts";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { formatDateTime } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

/**
 * Like an invite, the link is shown once and only while this dialog is open: closing it resets the
 * mutation, so the token is kept nowhere. Creating another link replaces the previous one.
 */
export function PasswordResetDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reset = useCreatePasswordReset();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) reset.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Creates a one-time link for {user.name} to choose a new password. Hyori doesn’t send
            email, so you share the link.
          </DialogDescription>
        </DialogHeader>
        {reset.data === undefined ? (
          <>
            <DialogBody>
              <FieldDescription>
                Their password stays the same until they use the link. Then they’re signed out on
                every device. A newer link replaces this one.
              </FieldDescription>
              <MutationFailure error={reset.error} describe={describeResetLinkError} />
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
              <Button
                pending={reset.isPending}
                pendingLabel="Creating…"
                onClick={() => reset.mutate({ userId: user.id })}
              >
                Create reset link
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="gap-1.5">
              <LinkField
                value={formatCloudPath({ section: "passwordReset", token: reset.data.token })}
                label="Reset link"
              />
              <FieldDescription>
                Copy this link now. It can’t be shown again. It works once, until{" "}
                {formatDateTime(reset.data.expiresAt)}.
              </FieldDescription>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Done</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

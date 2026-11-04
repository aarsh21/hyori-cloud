import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hyori-cloud/ui/components/alert-dialog";
import { Button } from "@hyori-cloud/ui/components/button";
import { Field } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { useState } from "@hyori-cloud/lib/react";
import type { AdminUser } from "#features/admin/react/admin-screen.tsx";
import { useDeleteUser } from "#features/admin/react/use-admin.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function DeleteUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <DeleteUserConfirmation user={user} onDeleted={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Lives inside the popup so each opening starts unconfirmed: a typed email never carries over. */
function DeleteUserConfirmation({ user, onDeleted }: { user: AdminUser; onDeleted: () => void }) {
  const [confirmation, setConfirmation] = useState("");
  const deleteUser = useDeleteUser();

  return (
    <>
      <AlertDialogTitle>Delete {user.name}’s account and files?</AlertDialogTitle>
      <AlertDialogDescription>
        This removes the account and every file they own. Files they uploaded to other people’s
        folders stay with those owners.
      </AlertDialogDescription>
      <Field>
        <Label htmlFor="delete-confirm">Type {user.email} to confirm</Label>
        <Input
          id="delete-confirm"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <MutationFailure error={deleteUser.error} />
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="ghost" type="button" />}>
          Cancel
        </AlertDialogClose>
        <Button
          type="button"
          variant="destructive"
          disabled={confirmation !== user.email}
          pending={deleteUser.isPending}
          pendingLabel="Deleting…"
          onClick={() =>
            deleteUser.mutate(
              { userId: user.id, confirmEmail: confirmation },
              { onSuccess: onDeleted },
            )
          }
        >
          Delete account and files
        </Button>
      </AlertDialogFooter>
    </>
  );
}

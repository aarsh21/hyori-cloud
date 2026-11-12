import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
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
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { describeChangePasswordError, newPasswordProblem } from "#features/auth/password-copy.ts";
import { NewPasswordField } from "#features/auth/react/new-password-field.tsx";
import { useChangePassword } from "#features/auth/react/use-password.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

/**
 * Nothing is retried automatically: a refusal keeps what was typed, and a lost reply says the change
 * may have happened rather than that it didn't.
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const change = useChangePassword();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        change.reset();
        setProblem(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Other devices and browsers are signed out. You stay signed in here.
          </DialogDescription>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) => {
            const newPassword = formText(values, "newPassword");
            const tooShort = newPasswordProblem(newPassword);

            setProblem(tooShort);

            // Only the current problem shows: an earlier refusal no longer describes this attempt.
            if (tooShort !== null) {
              change.reset();

              return;
            }

            change.mutate(
              { currentPassword: formText(values, "currentPassword"), newPassword },
              {
                onSuccess: () => {
                  onOpenChange(false);
                  toast.success("Password changed", {
                    description: "Other devices and browsers were signed out.",
                  });
                },
              },
            );
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor="change-password-current">Current password</Label>
              <PasswordInput
                id="change-password-current"
                name="currentPassword"
                autoComplete="current-password"
                required
                maxLength={1024}
                autoFocus
              />
            </Field>
            <NewPasswordField
              id="change-password-new"
              problem={problem}
              onEdit={() => setProblem(null)}
            />
            <MutationFailure error={change.error} describe={describeChangePasswordError} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={change.isPending} pendingLabel="Changing…">
              Change password
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

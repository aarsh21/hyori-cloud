import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Field, FieldDescription, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { useCreateUser } from "#features/admin/react/use-admin.ts";
import { AccountFields } from "#features/auth/react/account-fields.tsx";
import { BYTES_PER_GB } from "#features/shared/format.ts";
import { formText, optionalFormText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createUser = useCreateUser();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) createUser.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) => {
            const quota = optionalFormText(values, "quota");
            createUser.mutate(
              {
                name: formText(values, "name"),
                email: formText(values, "email"),
                password: formText(values, "password"),
                quotaBytes:
                  quota === undefined ? undefined : Math.round(Number(quota) * BYTES_PER_GB),
              },
              { onSuccess: () => onOpenChange(false) },
            );
          }}
        >
          <DialogBody>
            <AccountFields idPrefix="new-user" />
            <Field>
              <Label htmlFor="new-user-quota">Quota in GB (optional)</Label>
              <Input
                id="new-user-quota"
                name="quota"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                aria-describedby="new-user-quota-hint"
              />
              <FieldDescription id="new-user-quota-hint">
                Leave empty to use this server’s default.
              </FieldDescription>
            </Field>
            <MutationFailure error={createUser.error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={createUser.isPending} pendingLabel="Adding…">
              Add user
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

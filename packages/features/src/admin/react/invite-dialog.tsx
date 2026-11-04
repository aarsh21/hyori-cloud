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
import { Field, FieldDescription, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { useCreateInvite } from "#features/admin/react/use-admin.ts";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { formatDate } from "#features/shared/format.ts";
import { optionalFormText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invite = useCreateInvite();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) invite.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>They choose their own name and password.</DialogDescription>
        </DialogHeader>
        {invite.data === undefined ? (
          <Form
            className="gap-0"
            onValues={(values) => {
              const email = optionalFormText(values, "email");
              invite.mutate(email === undefined ? {} : { email });
            }}
          >
            <DialogBody>
              <Field>
                <Label htmlFor="invite-email">Email (optional)</Label>
                <Input
                  id="invite-email"
                  name="email"
                  type="email"
                  autoComplete="off"
                  maxLength={254}
                  aria-describedby="invite-email-hint"
                />
                <FieldDescription id="invite-email-hint">
                  Limits the invite to this address. Hyori doesn’t send email, so you share the
                  link.
                </FieldDescription>
              </Field>
              <MutationFailure error={invite.error} />
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
              <Button type="submit" pending={invite.isPending} pendingLabel="Creating…">
                Create invite link
              </Button>
            </DialogFooter>
          </Form>
        ) : (
          <>
            <DialogBody className="gap-1.5">
              <LinkField
                value={formatCloudPath({ section: "invite", token: invite.data.token })}
                label="Invite link"
              />
              <FieldDescription>
                Copy this link now. It can’t be shown again. Expires{" "}
                {formatDate(invite.data.expiresAt)}.
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

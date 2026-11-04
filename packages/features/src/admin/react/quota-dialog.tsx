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
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import type { AdminUser } from "#features/admin/react/admin-screen.tsx";
import { useSetQuota } from "#features/admin/react/use-admin.ts";
import { BYTES_PER_GB, formatBytes } from "#features/shared/format.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function QuotaDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setQuota = useSetQuota();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setQuota.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Storage quota for {user.name}</DialogTitle>
          <DialogDescription>Currently using {formatBytes(user.usedBytes)}.</DialogDescription>
        </DialogHeader>
        <Form
          className="gap-0"
          onValues={(values) =>
            setQuota.mutate(
              {
                userId: user.id,
                quotaBytes: Math.round(Number(formText(values, "quota")) * BYTES_PER_GB),
              },
              { onSuccess: () => onOpenChange(false) },
            )
          }
        >
          <DialogBody>
            <Field>
              <Label htmlFor="quota-gb">Quota in GB</Label>
              <Input
                id="quota-gb"
                name="quota"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                required
                defaultValue={Number((user.quotaBytes / BYTES_PER_GB).toFixed(2))}
              />
            </Field>
            <MutationFailure error={setQuota.error} />
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
            <Button type="submit" pending={setQuota.isPending} pendingLabel="Saving…">
              Save
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

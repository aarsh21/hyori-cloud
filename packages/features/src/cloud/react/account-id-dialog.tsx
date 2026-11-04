import { Button } from "@hyori-cloud/ui/components/button";
import { CopyField } from "@hyori-cloud/ui/components/copy-button";
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

/**
 * Account sharing is by account ID, because emails aren't verified identities. The ID stays on
 * screen and selectable until dismissed, so it can be exchanged even where the clipboard is blocked.
 */
export function AccountIdDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your account ID</DialogTitle>
          <DialogDescription>
            Send this to someone so they can share files and folders with you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <CopyField value={accountId} label="Account ID" />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

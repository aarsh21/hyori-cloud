import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hyori-cloud/ui/components/alert-dialog";
import { Button } from "@hyori-cloud/ui/components/button";

/** A revoked token can't be reissued, so this is the one sharing action with no way back. */
export function RevokeLinkDialog({
  open,
  linkName,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  /** Which link, in words: an irreversible action names its object. */
  linkName: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>Revoke the {linkName}?</AlertDialogTitle>
        <AlertDialogDescription>
          People using this link lose access now. You’d need to send a new link. It can’t retract
          anything already downloaded.
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" type="button" />}>
            Cancel
          </AlertDialogClose>
          <Button
            type="button"
            variant="destructive"
            pending={pending}
            pendingLabel="Revoking…"
            onClick={onConfirm}
          >
            Revoke link
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

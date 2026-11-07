import type { FileEntry } from "@hyori-cloud/client-sdk";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hyori-cloud/ui/components/alert-dialog";
import { Button } from "@hyori-cloud/ui/components/button";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { useDeletePermanently } from "#features/files/react/use-file-mutations.ts";
import { formatBytes } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

/** Holds its own entry: the row leaves Trash while this is still closing. */
export function DeletePermanentlyDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <DeletePermanentlyConfirmation entry={entry} onDeleted={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeletePermanentlyConfirmation({
  entry,
  onDeleted,
}: {
  entry: FileEntry;
  onDeleted: () => void;
}) {
  const remove = useDeletePermanently();

  return (
    <>
      <AlertDialogTitle>Permanently delete “{entry.name}”?</AlertDialogTitle>
      <AlertDialogDescription>
        {entry.kind === "folder"
          ? "The folder and everything in it are deleted now, along with their earlier versions and share links."
          : "The file is deleted now, along with its earlier versions and share links."}{" "}
        This can’t be undone.
      </AlertDialogDescription>
      <MutationFailure error={remove.error} />
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="ghost" type="button" />}>
          Cancel
        </AlertDialogClose>
        <Button
          type="button"
          variant="destructive"
          pending={remove.isPending}
          pendingLabel="Deleting…"
          onClick={() =>
            remove.mutate(
              { id: entry.id },
              {
                onSuccess: (result) => {
                  onDeleted();
                  toast(`Permanently deleted “${entry.name}”`, {
                    description:
                      result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)}` : undefined,
                  });
                },
              },
            )
          }
        >
          Delete permanently
        </Button>
      </AlertDialogFooter>
    </>
  );
}

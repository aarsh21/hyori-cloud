import type { FileVersion } from "@hyori-cloud/client-sdk";
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
import { useDeleteVersion } from "#features/files/react/use-file-mutations.ts";
import { formatBytes, formatDateTime } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

/** Holds its own version: the row leaves the history while this is still closing. */
export function DeleteVersionDialog({
  fileId,
  version,
  open,
  onOpenChange,
}: {
  fileId: string;
  version: FileVersion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <DeleteVersionConfirmation
          fileId={fileId}
          version={version}
          onDeleted={() => onOpenChange(false)}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteVersionConfirmation({
  fileId,
  version,
  onDeleted,
}: {
  fileId: string;
  version: FileVersion;
  onDeleted: () => void;
}) {
  const remove = useDeleteVersion();
  const created = formatDateTime(version.createdAt);

  return (
    <>
      <AlertDialogTitle>Delete the version from {created}?</AlertDialogTitle>
      <AlertDialogDescription>
        Its {formatBytes(version.size)} of contents are deleted permanently. The current version
        stays as it is. This can’t be undone.
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
              { id: fileId, versionId: version.id },
              {
                onSuccess: (result) => {
                  onDeleted();
                  toast(`Deleted the version from ${created}`, {
                    description:
                      result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)}` : undefined,
                  });
                },
              },
            )
          }
        >
          Delete version
        </Button>
      </AlertDialogFooter>
    </>
  );
}

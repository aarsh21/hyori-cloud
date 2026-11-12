import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@hyori-cloud/ui/components/alert-dialog";
import { Button } from "@hyori-cloud/ui/components/button";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { InlineText, Row, Text } from "@hyori-cloud/ui/components/text";
import { useEmptyTrash } from "#features/files/react/use-file-mutations.ts";
import { useTrashSummary } from "#features/files/react/use-trash-summary.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { formatBytes } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function EmptyTrashDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <EmptyTrashConfirmation open={open} onEmptied={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Lives inside the popup so each opening starts fresh, with a summary counted for that opening. */
function EmptyTrashConfirmation({ open, onEmptied }: { open: boolean; onEmptied: () => void }) {
  const emptyTrash = useEmptyTrash();

  return (
    <>
      <AlertDialogTitle>Empty Trash?</AlertDialogTitle>
      <AlertDialogDescription>
        Everything in Trash is deleted permanently, including folders’ contents. This can’t be
        undone.
      </AlertDialogDescription>
      <TrashSummaryLine enabled={open} />
      <MutationFailure error={emptyTrash.error} />
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="ghost" type="button" />}>
          Cancel
        </AlertDialogClose>
        <Button
          type="button"
          variant="destructive"
          pending={emptyTrash.isPending}
          pendingLabel="Emptying…"
          onClick={() =>
            emptyTrash.mutate(
              {},
              {
                onSuccess: (result) => {
                  onEmptied();
                  toast("Emptied Trash", {
                    description:
                      result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)}` : undefined,
                  });
                },
              },
            )
          }
        >
          Empty Trash
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/** One line whose height holds steady from counting through the result. */
function TrashSummaryLine({ enabled }: { enabled: boolean }) {
  const summary = useTrashSummary(enabled);

  if (summary.data !== undefined) {
    const { items, freedBytes } = summary.data;

    return (
      <Text numeric>
        {items.toLocaleString()} {items === 1 ? "item" : "items"} · frees {formatBytes(freedBytes)}
      </Text>
    );
  }

  if (summary.error !== null) {
    return (
      <Notice
        title={`Couldn’t total what’s in Trash. ${describeCloudError(summary.error).title}.`}
        action={
          <Button size="sm" variant="outline" onClick={() => summary.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    // Matches the result's line box (13px, relaxed) so nothing shifts when the count arrives.
    <Row aria-busy className="h-[1.3rem]">
      <InlineText className="sr-only">Totaling what’s in Trash…</InlineText>
      <Skeleton aria-hidden className="h-3 w-40" />
    </Row>
  );
}

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
import { SourceSelection, useSourcesDraft } from "#features/photos/react/source-selection.tsx";
import type { PhotoSourcesValue } from "#features/photos/react/source-selection.tsx";
import { useSetPhotoSources } from "#features/photos/react/use-photos.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function PhotoSourcesDialog({
  saved,
  open,
  onOpenChange,
}: {
  saved: PhotoSourcesValue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Photo sources</DialogTitle>
          <DialogDescription>
            Removing a source only hides its photos here. The files stay where they are.
          </DialogDescription>
        </DialogHeader>
        <PhotoSourcesForm saved={saved} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// Mounted with the dialog's popup, so reopening starts from what's saved rather than abandoned edits.
function PhotoSourcesForm({ saved, onDone }: { saved: PhotoSourcesValue; onDone: () => void }) {
  const draft = useSourcesDraft(saved);
  const save = useSetPhotoSources();

  return (
    <>
      <DialogBody>
        <SourceSelection draft={draft} />
        <MutationFailure error={save.error} />
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
        <Button
          type="button"
          disabled={!draft.canSave}
          pending={save.isPending}
          pendingLabel="Saving…"
          onClick={() =>
            save.mutate(
              { allMyFiles: draft.value.allMyFiles, folderIds: [...draft.value.folderIds] },
              { onSuccess: onDone },
            )
          }
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

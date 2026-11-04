import type { FileEntry } from "@hyori-cloud/client-sdk";
import { ChevronRight, Folder } from "@hyori-cloud/lib/icons";
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
import { PickerList, PickerRow, PickerRowButton } from "@hyori-cloud/ui/components/picker-list";
import { InlineText } from "@hyori-cloud/ui/components/text";
import { FolderPickerHeader } from "#features/files/react/folder-picker-header.tsx";
import { FolderPickerState } from "#features/files/react/folder-picker-state.tsx";
import { useFolderBrowser } from "#features/files/react/use-folder-browser.ts";
import { useMoveFile } from "#features/files/react/use-file-mutations.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function MoveDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const browser = useFolderBrowser(entry.parentId);
  const move = useMoveFile();
  const isCurrentLocation = browser.folderId === entry.parentId;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        move.reset();
        browser.open(entry.parentId);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{entry.name}”</DialogTitle>
        </DialogHeader>
        <DialogBody className="gap-2">
          <FolderPickerHeader
            title={browser.breadcrumbs.at(-1)?.name ?? "Files"}
            canGoBack={browser.folderId !== null}
            onBack={() => browser.open(browser.parentOf)}
          />
          <PickerList aria-label="Folders">
            {browser.folders.map((folder) => (
              <PickerRow key={folder.id}>
                <PickerRowButton
                  disabled={folder.id === entry.id}
                  onClick={() => browser.open(folder.id)}
                >
                  <Folder aria-hidden className="fill-folder/25 text-folder" />
                  <InlineText truncate className="flex-1">
                    {folder.name}
                  </InlineText>
                  <ChevronRight aria-hidden className="text-muted-foreground" />
                </PickerRowButton>
              </PickerRow>
            ))}
            <FolderPickerState listing={browser.listing} isEmpty={browser.folders.length === 0} />
          </PickerList>
          <MutationFailure error={move.error} />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
          <Button
            type="button"
            disabled={isCurrentLocation}
            pending={move.isPending}
            pendingLabel="Moving…"
            onClick={() =>
              move.mutate(
                { id: entry.id, parentId: browser.folderId },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

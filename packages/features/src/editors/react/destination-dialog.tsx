import { ChevronRight, Folder } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { PickerList, PickerRow, PickerRowButton } from "@hyori-cloud/ui/components/picker-list";
import { InlineText, Text } from "@hyori-cloud/ui/components/text";
import { useStoreValue } from "@hyori-cloud/ui/hooks/use-store-value";
import type { DestinationRequests } from "#features/editors/destination-requests.ts";
import { FolderPickerHeader } from "#features/files/react/folder-picker-header.tsx";
import { FolderPickerState } from "#features/files/react/folder-picker-state.tsx";
import { useFolderBrowser } from "#features/files/react/use-folder-browser.ts";

/**
 * What a visitor can choose from. An account starts at its own files, and a link at its own folder.
 * A link to a single file has no folder at all. The server still authorizes the one chosen.
 */
export type CopyDestination =
  | { readonly kind: "folder"; readonly folderId: string | null }
  | { readonly kind: "none" };

/** Asks where a copy or export should go. Answers only with the folder someone chose. */
export function DestinationDialog({
  requests,
  destination,
}: {
  requests: DestinationRequests;
  destination: CopyDestination;
}) {
  const output = useStoreValue(requests);

  return (
    <Dialog
      open={output !== null}
      onOpenChange={(open) => {
        if (!open) requests.answer(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save “{output?.name}” to…</DialogTitle>
        </DialogHeader>
        {destination.kind === "folder" ? (
          <FolderChoice requests={requests} rootFolderId={destination.folderId} />
        ) : (
          <NoFolderToChoose requests={requests} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FolderChoice({
  requests,
  rootFolderId,
}: {
  requests: DestinationRequests;
  rootFolderId: string | null;
}) {
  const browser = useFolderBrowser(rootFolderId);

  return (
    <>
      <DialogBody className="gap-2">
        <FolderPickerHeader
          title={browser.breadcrumbs.at(-1)?.name ?? "Files"}
          canGoBack={browser.folderId !== rootFolderId}
          onBack={() => browser.open(browser.parentOf)}
        />
        <PickerList aria-label="Folders">
          {browser.folders.map((folder) => (
            <PickerRow key={folder.id}>
              <PickerRowButton onClick={() => browser.open(folder.id)}>
                <Folder aria-hidden className="fill-folder/25 text-folder" />
                <InlineText truncate>{folder.name}</InlineText>
                <ChevronRight aria-hidden className="ml-auto text-muted-foreground" />
              </PickerRowButton>
            </PickerRow>
          ))}
          <FolderPickerState listing={browser.listing} isEmpty={browser.folders.length === 0} />
        </PickerList>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => requests.answer(null)}>
          Cancel
        </Button>
        <Button onClick={() => requests.answer({ parentId: browser.folderId })}>Save here</Button>
      </DialogFooter>
    </>
  );
}

function NoFolderToChoose({ requests }: { requests: DestinationRequests }) {
  return (
    <>
      <DialogBody>
        <Text tone="muted">
          This link only shares one file, so there’s no folder here to save a copy in.
        </Text>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => requests.answer(null)}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

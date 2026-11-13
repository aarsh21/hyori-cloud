import { ChevronRight, Folder } from "@hyori-cloud/lib/icons";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQuery } from "@hyori-cloud/lib/query";
import { useState } from "@hyori-cloud/lib/react";
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

/** Names the captured copy against the folder actually chosen, without reserving it. */
export function DestinationDialog({
  requests,
  destination,
  sessionId,
}: {
  requests: DestinationRequests;
  destination: CopyDestination;
  sessionId: string;
}) {
  const output = useStoreValue(requests);
  const [lastOutput, setLastOutput] = useState(output);

  // Answer immediately, but keep the last request's title throughout the exit transition.
  if (output !== null && output !== lastOutput) setLastOutput(output);
  const visible = output ?? lastOutput;

  return (
    <Dialog
      open={output !== null}
      onOpenChange={(open) => {
        if (!open) requests.answer(null);
      }}
    >
      <DialogContent>
        {destination.kind === "folder" && visible !== null ? (
          <FolderChoice
            requests={requests}
            rootFolderId={destination.folderId}
            output={visible}
            sessionId={sessionId}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Save “{visible?.name ?? ""}” to…</DialogTitle>
            </DialogHeader>
            <NoFolderToChoose requests={requests} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FolderChoice({
  requests,
  rootFolderId,
  output,
  sessionId,
}: {
  requests: DestinationRequests;
  rootFolderId: string | null;
  output: NonNullable<ReturnType<DestinationRequests["getSnapshot"]>>;
  sessionId: string;
}) {
  const browser = useFolderBrowser(rootFolderId);
  const suggestion = useCopyName(output, browser.folderId, sessionId);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {suggestion.data === undefined
            ? "Choose a folder for the copy"
            : `Save “${suggestion.data}” to…`}
        </DialogTitle>
      </DialogHeader>
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
        {suggestion.isError ? (
          <Text role="alert" tone="destructive">
            Couldn’t find an available name in this folder.{" "}
            <Button variant="link" onClick={() => suggestion.refetch()}>
              Try again
            </Button>
          </Text>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => requests.answer(null)}>
          Cancel
        </Button>
        <Button
          disabled={suggestion.data === undefined || suggestion.isFetching || suggestion.isError}
          onClick={() => requests.answer({ parentId: browser.folderId, name: suggestion.data })}
        >
          {suggestion.isFetching ? "Checking name…" : "Save here"}
        </Button>
      </DialogFooter>
    </>
  );
}

function useCopyName(
  output: NonNullable<ReturnType<DestinationRequests["getSnapshot"]>>,
  parentId: string | null,
  sessionId: string,
) {
  const { query } = useClientSDK();

  return useQuery({
    ...query.editors.suggestCopyName.getOptions({ ...output, parentId, sessionId }),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

function NoFolderToChoose({ requests }: { requests: DestinationRequests }) {
  return (
    <>
      <DialogBody>
        <Text tone="muted">
          This link only shares one file, so there’s no folder here to save a copy in. Your changes
          stay open, and Download my version saves them to this device.
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

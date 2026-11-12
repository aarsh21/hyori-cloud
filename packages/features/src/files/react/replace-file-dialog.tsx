import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useRef, useState } from "@hyori-cloud/lib/react";
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
import { FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import { PickerList, PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { InlineText, Stack, Text } from "@hyori-cloud/ui/components/text";
import { formatBytes, formatRecentDate } from "#features/shared/format.ts";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

/** Things worth a second look before confirming. None of them block it. */
function sourceNotes(source: File, entry: FileEntry) {
  return [
    source.name === entry.name ? null : `It will be saved as “${entry.name}”.`,
    source.type !== "" && source.type !== entry.mimeType
      ? "It’s a different type of file from the current version."
      : null,
    source.size === 0 ? "This file is empty." : null,
  ].filter((note) => note !== null);
}

/**
 * Asks for the source and a separate confirmation, so choosing a file can't replace anything by
 * itself. Progress and recovery then live in the upload tray with every other transfer, which lets
 * this close and browsing continue. Nothing changes on the server until the upload commits.
 */
export function ReplaceFileDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<File | null>(null);
  const picker = useRef<FilePickerHandle>(null);
  const queue = useUploadQueue();
  const notes = source === null ? [] : sourceNotes(source, entry);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setSource(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload new version</DialogTitle>
          <DialogDescription>
            Replaces the contents of “{entry.name}”. The current version moves to version history,
            and nothing changes unless the upload finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-2">
          <FilePicker
            ref={picker}
            multiple={false}
            onFiles={([file]) => {
              if (file !== undefined) setSource(file);
            }}
          />
          <PickerList aria-label="Versions" className="h-auto">
            <PickerRow className="justify-between gap-2 px-2 py-1 hover:bg-transparent">
              <Stack className="min-w-0">
                <InlineText size="xs" tone="muted">
                  Current version
                </InlineText>
                <InlineText truncate numeric>
                  {formatBytes(entry.size)} · {formatRecentDate(entry.updatedAt)}
                </InlineText>
              </Stack>
            </PickerRow>
            <PickerRow className="justify-between gap-2 px-2 py-1 hover:bg-transparent">
              <Stack className="min-w-0">
                <InlineText size="xs" tone="muted">
                  New version
                </InlineText>
                {source === null ? (
                  <InlineText>No file chosen</InlineText>
                ) : (
                  <InlineText truncate numeric title={source.name}>
                    {source.name} · {formatBytes(source.size)}
                  </InlineText>
                )}
              </Stack>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => picker.current?.open()}
              >
                {source === null ? "Choose file…" : "Change…"}
              </Button>
            </PickerRow>
          </PickerList>
          <Stack aria-live="polite" className="gap-0.5">
            {notes.map((note) => (
              <Text key={note} size="xs" tone="muted" className="wrap-anywhere">
                {note}
              </Text>
            ))}
          </Stack>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
          <Button
            type="button"
            disabled={source === null}
            onClick={() => {
              if (source === null) return;
              queue.replace({
                file: source,
                parentId: entry.parentId,
                target: { id: entry.id, name: entry.name },
              });
              onOpenChange(false);
            }}
          >
            Upload new version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

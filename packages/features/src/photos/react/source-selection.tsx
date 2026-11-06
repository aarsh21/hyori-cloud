import { ChevronRight, Folder } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { Checkbox } from "@hyori-cloud/ui/components/checkbox";
import { Label } from "@hyori-cloud/ui/components/label";
import { PickerList, PickerRow, PickerRowLabel } from "@hyori-cloud/ui/components/picker-list";
import { Switch } from "@hyori-cloud/ui/components/switch";
import { Tag } from "@hyori-cloud/ui/components/tag";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@hyori-cloud/ui/components/segmented-control";
import { InlineText, Row, SectionHeading, Stack, Text } from "@hyori-cloud/ui/components/text";
import { FolderPickerHeader } from "#features/files/react/folder-picker-header.tsx";
import { FolderPickerState } from "#features/files/react/folder-picker-state.tsx";
import { useFolderBrowser } from "#features/files/react/use-folder-browser.ts";

export type PhotoSourcesValue = {
  readonly allMyFiles: boolean;
  readonly folderIds: readonly string[];
};

/**
 * Only the user's edits are stored; display derives from them over the saved value, so a background
 * refetch can't overwrite a choice in progress and an untouched field keeps following the server.
 */
export function useSourcesDraft(saved: PhotoSourcesValue) {
  const [allMyFiles, setAllMyFiles] = useState<boolean | null>(null);
  const [folderIds, setFolderIds] = useState<readonly string[] | null>(null);

  const value: PhotoSourcesValue = {
    allMyFiles: allMyFiles ?? saved.allMyFiles,
    folderIds: folderIds ?? saved.folderIds,
  };

  return {
    value,
    canSave: value.allMyFiles || value.folderIds.length > 0,
    setAllMyFiles,
    toggleFolder(id: string, selected: boolean) {
      const rest = value.folderIds.filter((folderId) => folderId !== id);
      setFolderIds(selected ? [...rest, id] : rest);
    },
  };
}

export type SourcesDraft = ReturnType<typeof useSourcesDraft>;

type SourceRoot = "files" | "shared";

export function SourceSelection({ draft }: { draft: SourcesDraft }) {
  const [chosenRoot, setChosenRoot] = useState<SourceRoot>("files");
  const { allMyFiles } = draft.value;
  // Everything of one's own is already included, so only what's shared is left to choose from.
  const root = allMyFiles ? "shared" : chosenRoot;

  return (
    <Stack className="gap-3">
      <Row className="justify-between gap-4">
        <Stack className="min-w-0">
          <Label htmlFor="photos-all-files">All my files</Label>
          <Text size="xs" tone="muted">
            Find photos and videos anywhere in your own library.
          </Text>
        </Stack>
        <Switch
          id="photos-all-files"
          checked={allMyFiles}
          onCheckedChange={(checked) => draft.setAllMyFiles(checked)}
        />
      </Row>
      {allMyFiles ? (
        <SectionHeading>Also include folders shared with you</SectionHeading>
      ) : (
        <SegmentedControl
          className="self-start"
          label="Folders to choose from"
          value={chosenRoot}
          onValueChange={setChosenRoot}
        >
          <SegmentedControlItem value="files" label="My folders">
            My folders
          </SegmentedControlItem>
          <SegmentedControlItem value="shared" label="Shared with me">
            Shared with me
          </SegmentedControlItem>
        </SegmentedControl>
      )}
      {/* Keyed so each root starts at its own top rather than inside the other's folder. */}
      <SourceFolderPicker key={root} draft={draft} root={root} />
    </Stack>
  );
}

function SourceFolderPicker({ draft, root }: { draft: SourcesDraft; root: SourceRoot }) {
  const browser = useFolderBrowser(null, root);
  const selectedFolderIds = new Set(draft.value.folderIds);
  const selectedCount = draft.value.folderIds.length;

  return (
    <Stack className="gap-1.5">
      <FolderPickerHeader
        title={browser.breadcrumbs.at(-1)?.name ?? "Choose folders"}
        canGoBack={browser.folderId !== null}
        onBack={() => browser.open(browser.parentOf)}
      />
      <PickerList aria-label="Folders">
        {browser.folders.map((folder) => (
          <PickerRow key={folder.id}>
            <PickerRowLabel>
              <Checkbox
                checked={selectedFolderIds.has(folder.id)}
                onCheckedChange={(checked) => draft.toggleFolder(folder.id, checked)}
              />
              <Folder aria-hidden className="fill-folder/25 text-folder" />
              <InlineText truncate>{folder.name}</InlineText>
              {root === "files" &&
              browser.folderId === null &&
              folder.name.toLowerCase() === "pictures" ? (
                <Tag>Suggested</Tag>
              ) : null}
            </PickerRowLabel>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Open ${folder.name}`}
              onClick={() => browser.open(folder.id)}
            >
              <ChevronRight />
            </Button>
          </PickerRow>
        ))}
        <FolderPickerState listing={browser.listing} isEmpty={browser.folders.length === 0} />
      </PickerList>
      <Text size="xs" tone="muted" numeric>
        {selectedCount === 0
          ? "Subfolders and future uploads are included automatically."
          : `${selectedCount} ${selectedCount === 1 ? "folder" : "folders"} selected, including subfolders and future uploads.`}
        {root === "shared" ? " If sharing ends, those photos leave your timeline." : null}
      </Text>
    </Stack>
  );
}

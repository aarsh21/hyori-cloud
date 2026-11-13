import type { FileEntry } from "@hyori-cloud/client-sdk";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { useContext } from "@hyori-cloud/lib/react";
import { ItemButton, ItemLink } from "@hyori-cloud/ui/components/item-collection";
import { usePreloadWhenIdle } from "@hyori-cloud/ui/hooks/use-preload-when-idle";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { preloadEditorScreen } from "#features/cloud/react/cloud-screen-loaders.ts";
import { useOpenInEditor } from "#features/editors/react/use-open-in-editor.ts";
import { AvailableEditorsContext } from "#features/editors/react/use-available-editors.ts";
import { useFileActions } from "#features/files/react/file-actions.tsx";
import { useFolderPath } from "#features/files/react/folder-path.tsx";

/** The primary target opens an available editor, then falls back to preview or download. */
export function FileEntryTarget({ entry, children }: { entry: FileEntry; children: ReactNode }) {
  const { navigatePath } = useCloudNavigation();
  const folderPath = useFolderPath();
  const { openFile } = useFileActions();
  const editors = useContext(AvailableEditorsContext);

  if (editors === null)
    throw new Error("File entries require their browser's editor capabilities.");
  const openEditor = useOpenInEditor(entry, editors);

  // A document on screen may be opened next, and touch gives no hover or focus to preload on.
  usePreloadWhenIdle(openEditor === null || openEditor === undefined ? null : preloadEditorScreen);

  if (entry.kind === "folder") {
    return (
      <ItemLink href={folderPath(entry.id)} onNavigate={navigatePath}>
        {children}
      </ItemLink>
    );
  }

  return (
    <ItemButton
      aria-disabled={openEditor === undefined || undefined}
      aria-busy={openEditor === undefined || undefined}
      title={openEditor === undefined ? "Waiting for available editors" : undefined}
      onClick={(event) => {
        if (openEditor === undefined) return;

        // Modified activation belongs to selection, never an accidental open or download.
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;

        if (openEditor !== null) openEditor();
        else openFile(entry);
      }}
    >
      {children}
    </ItemButton>
  );
}

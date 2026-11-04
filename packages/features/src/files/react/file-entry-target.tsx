import type { FileEntry } from "@hyori-cloud/client-sdk";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { ItemButton, ItemLink } from "@hyori-cloud/ui/components/item-collection";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { useFileActions } from "#features/files/react/file-actions.tsx";
import { useFolderPath } from "#features/files/react/folder-path.tsx";

/** Folders are real links. Files open in the viewer when they're media and download otherwise. */
export function FileEntryTarget({ entry, children }: { entry: FileEntry; children: ReactNode }) {
  const { navigatePath } = useCloudNavigation();
  const folderPath = useFolderPath();
  const { openFile } = useFileActions();

  if (entry.kind === "folder") {
    return (
      <ItemLink href={folderPath(entry.id)} onNavigate={navigatePath}>
        {children}
      </ItemLink>
    );
  }

  return <ItemButton onClick={() => openFile(entry)}>{children}</ItemButton>;
}

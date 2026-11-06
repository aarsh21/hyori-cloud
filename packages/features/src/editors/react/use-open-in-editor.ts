import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useCloudNavigation, useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { editorForFile } from "#features/editors/editor-files.ts";
import { useAvailableEditors } from "#features/editors/react/use-available-editors.ts";

/**
 * An action, null when unavailable, or undefined while the server's capabilities are unresolved.
 * A link's visitor stays under the link that grants access. The server still decides on opening.
 */
export function useOpenInEditor(entry: FileEntry) {
  const { location } = useCloudNavigation();
  const navigateTo = useNavigateTo();
  const editors = useAvailableEditors();
  const { access, id, kind, name } = entry;

  if (kind !== "file" || !(access.canDownload || access.canEdit)) return null;

  // Don't turn an early click into a download while the default open action is still unknown.
  if (editors.data === undefined && editors.isPending) return undefined;

  if (editorForFile(name, editors.data?.apps ?? []) === undefined) return null;

  return () =>
    navigateTo(
      location.section === "publicShare"
        ? { section: "publicEditor", token: location.token, fileId: id }
        : { section: "editor", fileId: id },
    );
}

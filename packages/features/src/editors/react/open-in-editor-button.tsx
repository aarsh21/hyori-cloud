import type { FileEntry } from "@hyori-cloud/client-sdk";
import { FileText } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { usePreloadWhenIdle } from "@hyori-cloud/ui/hooks/use-preload-when-idle";
import { preloadEditorScreen } from "#features/cloud/react/cloud-screen-loaders.ts";
import { useOpenInEditor } from "#features/editors/react/use-open-in-editor.ts";
import { useAvailableEditors } from "#features/editors/react/use-available-editors.ts";

/** For a link to a single file, which has no row menu to offer this from. */
export function OpenInEditorButton({ entry }: { entry: FileEntry }) {
  const editors = useAvailableEditors();
  const open = useOpenInEditor(entry, editors);

  usePreloadWhenIdle(open === null || open === undefined ? null : preloadEditorScreen);

  if (open === null || open === undefined) return null;

  return (
    <Button size="lg" variant="outline" onClick={open}>
      <FileText aria-hidden />
      Open in editor
    </Button>
  );
}

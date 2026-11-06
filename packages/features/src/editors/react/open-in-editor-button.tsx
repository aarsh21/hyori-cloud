import type { FileEntry } from "@hyori-cloud/client-sdk";
import { FileText } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { useOpenInEditor } from "#features/editors/react/use-open-in-editor.ts";

/** For a link to a single file, which has no row menu to offer this from. */
export function OpenInEditorButton({ entry }: { entry: FileEntry }) {
  const open = useOpenInEditor(entry);

  if (open === null || open === undefined) return null;

  return (
    <Button size="lg" variant="outline" onClick={open}>
      <FileText aria-hidden />
      Open in editor
    </Button>
  );
}

import type { FileEntry } from "@hyori-cloud/client-sdk";
import { FileText } from "@hyori-cloud/lib/icons";
import { DropdownMenuItem } from "@hyori-cloud/ui/components/dropdown-menu";
import { useOpenInEditor } from "#features/editors/react/use-open-in-editor.ts";
import { useAvailableEditors } from "#features/editors/react/use-available-editors.ts";

export function OpenInEditorItem({ entry }: { entry: FileEntry }) {
  const editors = useAvailableEditors();
  const open = useOpenInEditor(entry, editors);

  if (open === null || open === undefined) return null;

  return (
    <DropdownMenuItem onClick={open}>
      <FileText />
      Open in editor
    </DropdownMenuItem>
  );
}

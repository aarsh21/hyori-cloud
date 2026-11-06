"use client";

import {
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useSingleKeyShortcuts } from "@hyori-cloud/ui/hooks/use-single-key-shortcuts";
import { writeSingleKeyShortcuts } from "@hyori-cloud/ui/lib/single-key-shortcuts";

/** A stray keypress or speech input can trigger single-key shortcuts, so they can be turned off. */
export function ShortcutPreferenceMenuItems() {
  const enabled = useSingleKeyShortcuts();

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem checked={enabled} onCheckedChange={writeSingleKeyShortcuts}>
        Single-key shortcuts
      </DropdownMenuCheckboxItem>
    </>
  );
}

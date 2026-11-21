"use client";

import { BlockNoteDefaultUI, ComponentsContext } from "@blocknote/react";
import { ShadCNComponentsContext, ShadCNDefaultComponents, components } from "@blocknote/shadcn";
import { Button } from "@hyori-cloud/ui/components/button";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";

const shadCNComponents = {
  ...ShadCNDefaultComponents,
  Button: { Button },
  Input: { Input },
  Label: { Label },
};

/**
 * BlockNote's default menus — formatting and link toolbars, slash and emoji menus, side menu,
 * table handles — drawn with the shared shadcn controls. Rendered inside the editor's view, the
 * place `BlockNoteView` itself renders them, so they behave exactly as the built-in UI.
 */
export function NoteEditorMenus() {
  return (
    <ShadCNComponentsContext.Provider value={shadCNComponents}>
      <ComponentsContext.Provider value={components}>
        <BlockNoteDefaultUI />
      </ComponentsContext.Provider>
    </ShadCNComponentsContext.Provider>
  );
}

// Shared source consumers also need the stylesheet declaration, not only this package's tsconfig.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../styles/css.d.ts" />
"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";
import { useImperativeHandle, type Ref } from "react";
import { useAppearance } from "@hyori-cloud/ui/theme";
import { Button } from "@hyori-cloud/ui/components/button";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import "@blocknote/shadcn/style.css";
import "../styles/note-editor.css";

// Binary/media assets stay in Files rather than embedding arbitrary external URLs in a room.
const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
    table: defaultBlockSpecs.table,
    divider: defaultBlockSpecs.divider,
    toggleListItem: defaultBlockSpecs.toggleListItem,
  },
});

export type NoteEditorControl = {
  markdown(): string;
  json(): string;
  appendMarkdown(text: string): void;
};

/** Owned BlockNote adapter. The live Y.Doc is the content, not a React value/onChange mirror. */
export function NoteEditor({
  doc,
  awareness,
  user,
  editable,
  control,
}: {
  doc: Doc;
  awareness: Awareness;
  user: { name: string; color: string };
  editable: boolean;
  control: Ref<NoteEditorControl>;
}) {
  const { resolved } = useAppearance();

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      collaboration: { fragment: doc.getXmlFragment("prosemirror"), provider: { awareness }, user },
      trailingBlock: true,
    }),
    [doc],
  );

  useImperativeHandle(
    control,
    () => ({
      markdown: () => editor.blocksToMarkdownLossy(),
      json: () => JSON.stringify(editor.document, null, 2),
      appendMarkdown(text) {
        const blocks = editor.tryParseMarkdownToBlocks(text);

        if (editor.isEmpty) editor.replaceBlocks(editor.document, blocks);
        else editor.insertBlocks(blocks, editor.document[editor.document.length - 1]!, "after");
      },
    }),
    [editor],
  );

  return (
    <BlockNoteView
      editor={editor}
      editable={editable}
      theme={resolved ?? "light"}
      className="hyori-note-editor"
      shadCNComponents={{ Button: { Button }, Input: { Input }, Label: { Label } }}
    />
  );
}

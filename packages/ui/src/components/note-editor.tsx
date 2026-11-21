// Shared source consumers also need the stylesheet declaration, not only this package's tsconfig.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../styles/css.d.ts" />
"use client";

import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteViewRaw, useCreateBlockNote } from "@blocknote/react";
import type { Awareness } from "y-protocols/awareness";
import type { Doc } from "yjs";
import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { useAppearance } from "@hyori-cloud/ui/theme";
import { NoteCursorsExtension } from "@hyori-cloud/ui/lib/note-cursors";
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

type MenusModule = typeof import("./note-editor-menus");

let arrivedMenus: MenusModule | null = null;

/**
 * The menus and the shadcn controls that draw them are their own chunk, mounted once the editable
 * document has painted. None is visible before someone selects, hovers or types a trigger, and on
 * a phone their setup — the formatting toolbar's virtual-keyboard tracking forces a full style
 * recalculation — held up the first paint. A trigger typed before they arrive still opens its menu:
 * the editor registers the triggers itself, and the menu reads that state when it mounts. A failed
 * chunk is asked for again when the connection returns or the next editor mounts; meanwhile the
 * editor keeps working without menus.
 */
function useDeferredMenus() {
  const [menus, setMenus] = useState(() => arrivedMenus);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (menus !== null || failed) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let painted = () => {};
    const loaded = import("./note-editor-menus");

    // A frame, then a task: the browser has painted the editor before the menus render.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => painted());
    });

    Promise.all([loaded, new Promise<void>((resolve) => (painted = resolve))])
      .then(([module]) => {
        arrivedMenus = module;

        if (!cancelled) setMenus(module);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [menus, failed]);

  useEffect(() => {
    if (!failed) return undefined;

    const retry = () => setFailed(false);

    window.addEventListener("online", retry);

    return () => window.removeEventListener("online", retry);
  }, [failed]);

  return menus;
}

export type NoteEditorControl = {
  markdown(): string;
  json(): string;
  appendMarkdown(text: string): void;
  focus(): void;
};

/** Owned BlockNote adapter. The live Y.Doc is the content, not a React value/onChange mirror. */
export function NoteEditor({
  doc,
  awareness,
  user,
  editable,
  control,
  holdRemoteChanges,
}: {
  doc: Doc;
  awareness: Awareness;
  user: { name: string; color: string };
  editable: boolean;
  control: Ref<NoteEditorControl>;
  /** Keeps peers' content out of the document while this editor holds an open composition. */
  holdRemoteChanges?: () => () => void;
}) {
  const { resolved } = useAppearance();
  const menus = useDeferredMenus();

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      // No provider: BlockNote's widget cursors are replaced by an overlay outside the editable DOM.
      collaboration: { fragment: doc.getXmlFragment("prosemirror"), user },
      extensions: [NoteCursorsExtension({ awareness, holdRemoteChanges })],
      trailingBlock: true,
    }),
    [doc],
  );

  // The menus' own trigger registrations, made with the editor so a "/" or ":" typed before the
  // menus arrive is tracked rather than left as text. The menus repeat them when they mount.
  useEffect(() => {
    const suggestions = editor.getExtension(SuggestionMenu);

    suggestions?.addSuggestionMenu({
      triggerCharacter: "/",
      shouldOpen: (transaction) =>
        !transaction.selection.$from.parent.type.isInGroup("tableContent"),
    });
    suggestions?.addSuggestionMenu({ triggerCharacter: ":" });
  }, [editor]);

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
      focus: () => editor.focus(),
    }),
    [editor],
  );

  return (
    <BlockNoteViewRaw
      editor={editor}
      editable={editable}
      theme={resolved ?? "light"}
      className="bn-shadcn hyori-note-editor"
    >
      {menus !== null && <menus.NoteEditorMenus />}
    </BlockNoteViewRaw>
  );
}

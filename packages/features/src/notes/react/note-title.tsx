import { useState } from "@hyori-cloud/lib/react";
import type { Ref } from "@hyori-cloud/lib/react";
import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { TitleInput } from "@hyori-cloud/ui/components/title-input";
import { useRenameNote } from "#features/notes/react/use-notes.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

type Note = OutputOf<RPC["notes"]["get"]>;

const TITLE = "text-[32px] leading-[1.2] font-semibold tracking-[-0.02em] wrap-anywhere";

/** The server names a note "Untitled note 2" until someone names it; the field shows it as unnamed. */
const SERVER_DEFAULT_NAME = /^Untitled note(?: \d+)?$/;

/** Sibling notes need distinct titles, and a rename elsewhere moves the fence; both conflict alike. */
function describeTitleError(error: CloudError) {
  if (error.code !== "resource.conflict") return describeCloudError(error);

  return {
    title: "Couldn’t use this title",
    detail:
      "Another note here already has it, or the note was just renamed elsewhere. Try a different title, or press Esc to keep the current one.",
  };
}

/** The text being edited, and the name it started from, which fences the rename against conflicts. */
type Draft = { base: string; text: string };

/**
 * The note's title, edited in place. It saves through rename when focus leaves it, so Enter (which
 * moves on to the body) and clicking away share one path. A blank or unchanged title saves nothing.
 */
export function NoteTitle({
  note,
  editable,
  inputRef,
  onEnter,
}: {
  note: Note;
  editable: boolean;
  inputRef: Ref<HTMLTextAreaElement>;
  /** Moves the caret on. When the body can't take it yet, the title simply loses focus. */
  onEnter(field: HTMLTextAreaElement): void;
}) {
  const rename = useRenameNote();
  const [draft, setDraft] = useState<Draft | null>(null);
  const name = note.file.name;
  const shown = SERVER_DEFAULT_NAME.test(name) ? "" : name;

  if (!editable) return <h1 className={`${TITLE} text-balance`}>{name}</h1>;

  function save() {
    if (draft === null) return;
    const next = draft.text.trim();

    if (next === "" || next === draft.base) {
      setDraft(null);

      return;
    }

    rename.mutate(
      { id: note.file.id, name: next, expectedName: draft.base },
      { onSuccess: () => setDraft(null) },
    );
  }

  return (
    <>
      <h1 className={TITLE}>
        <TitleInput
          ref={inputRef}
          aria-label="Title"
          placeholder="Untitled"
          maxLength={255}
          value={draft?.text ?? shown}
          onFocus={() => setDraft((current) => current ?? { base: name, text: shown })}
          // Pasted line breaks would make a title the server can't store as one line.
          onChange={(event) =>
            setDraft({
              base: draft?.base ?? name,
              text: event.target.value.replace(/\s*\n\s*/g, " "),
            })
          }
          onBlur={save}
          onEnter={onEnter}
          onEscape={() => {
            rename.reset();
            setDraft({ base: name, text: shown });
          }}
        />
      </h1>
      <div className="mt-2 empty:hidden">
        <MutationFailure error={rename.error} describe={describeTitleError} />
      </div>
    </>
  );
}

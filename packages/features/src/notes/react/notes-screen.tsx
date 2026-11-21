import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import type { ComponentProps } from "@hyori-cloud/lib/react";
import { NotebookPen, Plus, Search, Star } from "@hyori-cloud/lib/icons";
import { useDeferredValue, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { Input } from "@hyori-cloud/ui/components/input";
import { NoteListItem, NoteWorkspace } from "@hyori-cloud/ui/components/note-workspace";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Text } from "@hyori-cloud/ui/components/text";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import {
  preloadNoteDocument,
  useNoteDocument,
} from "#features/cloud/react/cloud-screen-loaders.ts";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { useCreateNote, useNotes } from "#features/notes/react/use-notes.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

type Note = OutputOf<RPC["notes"]["get"]>;

type NoteDocumentScreen = NonNullable<ReturnType<typeof useNoteDocument>>["NoteDocument"];

function NoteDocument(props: ComponentProps<NoteDocumentScreen>) {
  const editor = useNoteDocument();

  if (editor === undefined)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );

  return <editor.NoteDocument {...props} />;
}

/**
 * Start the shared editor import when the Notes screen commits, beside the list's own request
 * rather than a round trip behind it: on a slow phone the editor's code is most of the wait for
 * the first note opened from the list. Not on sidebar intent, and never for other sections.
 */
function onNotesScreenReady(node: HTMLDivElement | null) {
  if (node !== null) preloadNoteDocument();
}

/** Only an unfiltered, loaded, empty first page proves there are no notes at all. */
function mayHaveNotes(loadedCount: number | undefined, narrowed: boolean) {
  return loadedCount === undefined || loadedCount > 0 || narrowed;
}

export function NotesScreen({ noteId }: { noteId: string | null }) {
  const user = useCurrentUser();
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const deferredSearch = useDeferredValue(search);
  const notes = useNotes({ search: deferredSearch, favorites, trash: false, cursor });
  const narrowed = search !== "" || favorites || cursor !== undefined;
  const hasNotes = mayHaveNotes(notes.data?.items.length, narrowed);
  const create = useCreateNote();
  const { navigatePath } = useCloudNavigation();

  // The note created last opens ready to type. The flag is dropped when the list navigates
  // elsewhere, because the document mounts a network round-trip after the route reaches it; a
  // later visit from the list is not treated as the one that was just created.
  const [createdId, setCreatedId] = useState<string | null>(null);

  function newNote(parentId: string | null = null) {
    create.mutate(
      { parentId },
      {
        onSuccess(note) {
          setCreatedId(note.file.id);
          navigatePath(formatCloudPath({ section: "notes", noteId: note.file.id }));
        },
      },
    );
  }

  return (
    <NoteWorkspace
      opened={noteId !== null}
      sidebar={
        <>
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <h1 className="text-sm font-medium">Notes</h1>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New note"
              pending={create.isPending}
              onClick={() => newNote()}
            >
              <Plus />
            </Button>
          </header>
          <div className="space-y-3 px-3 py-4">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground"
              />
              <Input
                aria-label="Find a note"
                placeholder="Find a note…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setCursor(undefined);
                }}
                className="h-9 pl-8 text-[13px]"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={favorites}
              className="w-full justify-start text-muted-foreground"
              onClick={() => {
                setFavorites(!favorites);
                setCursor(undefined);
              }}
            >
              <Star />
              Favorites
            </Button>
            <MutationFailure error={create.error} />
          </div>
          <div ref={onNotesScreenReady} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {notes.data === undefined ? (
              <QueryWaiting
                resource={notes}
                pending={
                  <Text tone="muted" className="px-3">
                    Loading notes…
                  </Text>
                }
              />
            ) : (
              <>
                {notes.error !== null && (
                  <RefreshFailure error={notes.error} onRetry={() => notes.refetch()} />
                )}
                {notes.data.items.length === 0 ? (
                  (search || favorites) && (
                    <p className="px-3 py-6 text-[13px] text-muted-foreground">
                      No matching notes.
                    </p>
                  )
                ) : (
                  <NoteTree
                    notes={notes.data.items}
                    current={noteId}
                    flatten={search !== "" || favorites || cursor !== undefined}
                    onLeave={() => setCreatedId(null)}
                  />
                )}
                {notes.data.nextCursor !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCursor(notes.data!.nextCursor!)}
                  >
                    Next notes
                  </Button>
                )}
                {cursor !== undefined && (
                  <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
                    Back to first notes
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      }
    >
      {noteId === null ? (
        <RegionState
          icon={<NotebookPen />}
          title={hasNotes ? "Choose a note" : "No notes yet"}
          description={
            hasNotes
              ? "Open one from the list, or start a new one."
              : "Notes save as you type and stay private until you share them."
          }
          action={
            <Button variant="outline" onClick={() => newNote()} pending={create.isPending}>
              <Plus />
              Create a note
            </Button>
          }
        />
      ) : (
        <NoteDocument
          key={noteId}
          id={noteId}
          accountId={user.id}
          autoFocus={createdId === noteId}
          onNewChild={() => newNote(noteId)}
        />
      )}
    </NoteWorkspace>
  );
}

function NoteTree({
  notes,
  current,
  flatten,
  onLeave,
}: {
  notes: readonly Note[];
  current: string | null;
  flatten: boolean;
  onLeave: () => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { navigatePath } = useCloudNavigation();
  const ids = new Set(notes.map((note) => note.file.id));

  function rows(parent: string | null, depth: number): React.ReactNode {
    return notes
      .filter((n) => {
        if (flatten) return parent === null;

        if (parent === null) return !ids.has(n.file.parentId ?? "");

        return n.file.parentId === parent;
      })
      .map((note) => {
        const id = note.file.id;
        const expanded = !collapsed.has(id);

        return (
          <div key={id}>
            <NoteListItem
              name={note.file.name}
              current={current === id}
              depth={depth}
              favorite={note.favorite}
              expanded={expanded}
              hasChildren={!flatten && notes.some((n) => n.file.parentId === id)}
              onToggle={() =>
                setCollapsed((old) => {
                  const next = new Set(old);

                  if (next.has(id)) next.delete(id);
                  else next.add(id);

                  return next;
                })
              }
              href={formatCloudPath({ section: "notes", noteId: id })}
              onNavigate={(path) => {
                // Leaving for another note ends the visit that creation started.
                onLeave();
                navigatePath(path);
              }}
            />
            {expanded && !flatten && rows(id, depth + 1)}
          </div>
        );
      });
  }

  return <nav aria-label="All notes">{rows(null, 0)}</nav>;
}

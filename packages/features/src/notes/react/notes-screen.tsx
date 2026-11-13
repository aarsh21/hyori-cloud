import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { FileText, Plus, Search, Star } from "@hyori-cloud/lib/icons";
import { useDeferredValue, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { Input } from "@hyori-cloud/ui/components/input";
import { NoteListItem, NoteWorkspace } from "@hyori-cloud/ui/components/note-workspace";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Text } from "@hyori-cloud/ui/components/text";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { NoteDocument } from "#features/notes/react/note-document.tsx";
import { useCreateNote, useNotes } from "#features/notes/react/use-notes.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

type Note = OutputOf<RPC["notes"]["get"]>;

export function NotesScreen({ noteId }: { noteId: string | null }) {
  const user = useCurrentUser();
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const deferredSearch = useDeferredValue(search);
  const notes = useNotes({ search: deferredSearch, favorites, trash: false, cursor });
  const create = useCreateNote();
  const { navigatePath } = useCloudNavigation();

  function newNote(parentId: string | null = null) {
    create.mutate(
      { parentId },
      {
        onSuccess(note) {
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
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
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
                  <p className="px-3 py-6 text-[13px] text-muted-foreground">
                    {search || favorites
                      ? "No matching notes."
                      : "Your thoughts, all in one place."}
                  </p>
                ) : (
                  <NoteTree
                    notes={notes.data.items}
                    current={noteId}
                    flatten={search !== "" || favorites || cursor !== undefined}
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
          <div className="border-t border-border p-3 text-xs text-muted-foreground">
            Private until you share.
          </div>
        </>
      }
    >
      {noteId === null ? (
        <RegionState
          icon={<FileText />}
          title="A little room to think"
          description="Write, plan, and work on a note together. Changes are saved as you go."
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
}: {
  notes: readonly Note[];
  current: string | null;
  flatten: boolean;
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
              onNavigate={navigatePath}
            />
            {expanded && !flatten && rows(id, depth + 1)}
          </div>
        );
      });
  }

  return <nav aria-label="All notes">{rows(null, 0)}</nav>;
}

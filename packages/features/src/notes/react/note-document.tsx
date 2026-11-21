import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { createCollaborationSession } from "@hyori-cloud/client-sdk/collaboration";
import {
  createBrowserCollaborationJournal,
  createBrowserPageExit,
} from "@hyori-cloud/client-sdk/browser";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { ArrowLeft, Ellipsis, Lock, Plus, Share2, Star } from "@hyori-cloud/lib/icons";
import { useRef, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { NoteEditor, type NoteEditorControl } from "@hyori-cloud/ui/components/note-editor";
import { NoteCanvas } from "@hyori-cloud/ui/components/note-workspace";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Spinner } from "@hyori-cloud/ui/components/spinner";
import { Textarea } from "@hyori-cloud/ui/components/textarea";
import { useDisposeOnUnmount } from "@hyori-cloud/ui/hooks/use-dispose-on-unmount";
import { useDocumentKeydown } from "@hyori-cloud/ui/hooks/use-document-keydown";
import { useFocusWhenActive } from "@hyori-cloud/ui/hooks/use-focus-when-active";
import { useStoreValue } from "@hyori-cloud/ui/hooks/use-store-value";
import { saveBytesAsDownload } from "@hyori-cloud/ui/lib/browser";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useTrashFile } from "#features/files/react/use-file-mutations.ts";
import {
  useCheckpointNote,
  useFavoriteNote,
  useNote,
  useNoteHistory,
  useRenameNote,
  useRestoreNoteCheckpoint,
} from "#features/notes/react/use-notes.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { ShareDialog } from "#features/sharing/react/share-dialog.tsx";

type Note = OutputOf<RPC["notes"]["get"]>;

export function NoteDocument({
  id,
  accountId,
  autoFocus = false,
  onNewChild,
  closePath = "/notes",
}: {
  id: string;
  accountId?: string;
  /** True only for the mount that follows creating this note, so the caret lands in the editor. */
  autoFocus?: boolean;
  onNewChild?: () => void;
  closePath?: string;
}) {
  const note = useNote(id);
  const [attempt, setAttempt] = useState(0);
  const trash = useTrashFile();
  // Once this page moves its note to Trash it is leaving, so the refresh that finds the note gone is
  // the expected result, not a failure to announce.
  const leaving = trash.isPending || trash.isSuccess;

  if (note.data === undefined)
    return (
      <QueryWaiting
        resource={note}
        pending={
          <div className="p-8">
            <Spinner />
          </div>
        }
      />
    );

  return (
    <>
      {note.error !== null && !leaving && (
        <RefreshFailure error={note.error} onRetry={() => note.refetch()} />
      )}
      <NoteAttempt
        key={`${id}:${attempt}`}
        note={note.data}
        autoFocus={autoFocus}
        trash={trash}
        accountId={accountId}
        closePath={closePath}
        onNewChild={onNewChild}
        onReopen={() => {
          void note.refetch();
          setAttempt((value) => value + 1);
        }}
      />
    </>
  );
}

function NoteAttempt({
  note,
  autoFocus,
  trash,
  accountId,
  onNewChild,
  closePath,
  onReopen,
}: {
  note: Note;
  autoFocus: boolean;
  trash: ReturnType<typeof useTrashFile>;
  accountId?: string | undefined;
  onNewChild?: (() => void) | undefined;
  closePath: string;
  onReopen(): void;
}) {
  const sdk = useClientSDK();
  const { navigationGuard, navigatePath } = useCloudNavigation();

  const [session] = useState(() => {
    let release: (() => void) | undefined;

    return createCollaborationSession({
      id: note.file.id,
      backend: sdk.rpc.collaboration,
      journal: accountId ? createBrowserCollaborationJournal(accountId, note.file.id) : undefined,
      pageExit: createBrowserPageExit(),
      onUnsavedChange(unsaved) {
        if (unsaved) release ??= navigationGuard.hold();
        else {
          release?.();
          release = undefined;
        }
      },
    });
  });

  useDisposeOnUnmount(() => session.dispose());
  const state = useStoreValue(session);
  const control = useRef<NoteEditorControl>(null);
  const [sharing, setSharing] = useState(false);
  const [history, setHistory] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const favorite = useFavoriteNote();

  // A note the user just created opens with the caret in its editor, so the first words typed are
  // the note and not a shortcut on the button that made it. The mount snapshot keeps this to the
  // one opening that follows creation, never a later visit to the same note.
  const shouldFocus = useRef(autoFocus).current;
  const editorMounted = state.document !== null && session.awareness !== null;

  useFocusWhenActive(shouldFocus && editorMounted, () => control.current?.focus());

  useDocumentKeydown((event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.altKey) {
      event.preventDefault();

      if (state.writable) void session.flush();
    }
  });

  function exportNote(format: "markdown" | "json") {
    const text = format === "markdown" ? control.current?.markdown() : control.current?.json();

    if (text !== undefined)
      saveBytesAsDownload(
        new TextEncoder().encode(text),
        `${note.file.name}.${format === "markdown" ? "md" : "json"}`,
      );
  }

  const status = {
    opening: "Opening…",
    saved: "Saved to Hyori",
    pending: "Saving…",
    offline: "Waiting to sync",
    blocked: "Editing paused",
  }[state.status];

  return (
    <>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to notes"
          onClick={() => navigatePath(closePath)}
        >
          <ArrowLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-[13px] max-sm:hidden">{note.file.name}</span>
        <span role="status" className="mr-auto shrink-0 text-xs text-muted-foreground">
          {status}
        </span>
        {state.peers.length > 0 && (
          <span
            title={state.peers.join(", ")}
            className="max-w-32 truncate rounded-full border border-border px-2 py-1 text-xs"
          >
            {state.peers.length}
            <span className="max-sm:hidden"> here with you</span>
          </span>
        )}
        {accountId && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={note.favorite ? "Remove favorite" : "Favorite note"}
            aria-pressed={note.favorite}
            disabled={favorite.isPending}
            onClick={() => favorite.mutate({ id: note.file.id, favorite: !note.favorite })}
          >
            <Star className={note.favorite ? "fill-current" : undefined} />
          </Button>
        )}
        {note.file.access.canShare && (
          <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
            <Share2 />
            <span className="max-sm:sr-only">Share</span>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Note actions" />}
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {state.writable && (
              <DropdownMenuItem onClick={() => void session.flush()}>Save now</DropdownMenuItem>
            )}
            {state.writable && note.file.access.canRename && (
              <DropdownMenuItem onClick={() => setRenameOpen(true)}>Rename</DropdownMenuItem>
            )}
            {onNewChild && state.writable && (
              <DropdownMenuItem onClick={onNewChild}>
                <Plus />
                Add nested note
              </DropdownMenuItem>
            )}
            {state.writable && (
              <DropdownMenuItem onClick={() => setImportOpen(true)}>
                Import Markdown
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={state.document === null}
              onClick={() => exportNote("markdown")}
            >
              Export Markdown
            </DropdownMenuItem>
            <DropdownMenuItem disabled={state.document === null} onClick={() => exportNote("json")}>
              Export blocks
            </DropdownMenuItem>
            {note.file.access.canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setHistory(true)}>
                  Version history
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTrashOpen(true)}>
                  Move to Trash
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="space-y-2 px-5 pt-3 empty:hidden">
        {state.error && (
          <Notice
            title={
              state.status === "offline" ? "Working offline" : "This note needs your attention"
            }
            tone={state.status === "offline" ? "offline" : "error"}
            action={
              state.document === null ? (
                <Button variant="outline" size="sm" onClick={onReopen}>
                  Try again
                </Button>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => exportNote("markdown")}>
                    Export my work
                  </Button>
                  {state.status === "blocked" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void session.discardRecovery().then(onReopen)}
                    >
                      Open latest version
                    </Button>
                  )}
                </div>
              )
            }
          >
            {state.error}
            {state.status === "blocked" && state.document !== null && (
              <p className="mt-1">
                Export first. Opening the latest version discards this device’s recovery branch.
              </p>
            )}
          </Notice>
        )}
        {state.recoveryError && (
          <Notice title="Device recovery is unavailable">
            Keep this tab open until your edits say “Saved to Hyori”, or export your work.
          </Notice>
        )}
        <MutationFailure error={favorite.error} />
      </div>
      <NoteCanvas>
        <div className="px-9 pb-6">
          {!state.writable && (
            <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" aria-hidden />
              Read only
            </p>
          )}
          <h1 className="text-[32px] leading-[1.2] font-semibold tracking-[-0.02em] text-balance wrap-anywhere">
            {note.file.name}
          </h1>
        </div>
        {state.document !== null && session.awareness !== null && (
          <NoteEditor
            doc={session.doc}
            awareness={session.awareness}
            user={{ name: state.document.name, color: state.document.color }}
            editable={state.writable}
            control={control}
            holdRemoteChanges={session.holdRemoteChanges}
          />
        )}
        {state.status === "opening" && (
          <div className="px-9 py-6">
            <Spinner />
          </div>
        )}
      </NoteCanvas>
      {note.file.access.canShare && (
        <ShareDialog entry={note.file} open={sharing} onOpenChange={setSharing} />
      )}
      <RenameNoteDialog note={note} open={renameOpen} onOpenChange={setRenameOpen} />
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bring your writing in</DialogTitle>
            <DialogDescription>
              Paste Markdown to append it to this note. Existing work stays in place.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Form
              onValues={(values) => {
                if (!state.writable) return;
                control.current?.appendMarkdown(String(values.get("markdown")));
                setImportOpen(false);
              }}
            >
              <Textarea
                name="markdown"
                aria-label="Markdown to import"
                required
                maxLength={16000}
                className="min-h-48"
              />
              <Button type="submit" disabled={!state.writable}>
                Add to note
              </Button>
            </Form>
          </DialogBody>
        </DialogContent>
      </Dialog>
      <NoteHistoryDialog
        id={note.file.id}
        session={session}
        open={history}
        onOpenChange={setHistory}
      />
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move “{note.file.name}” to Trash?</DialogTitle>
            <DialogDescription>
              Its nested notes move with it. You can restore them from Trash.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <MutationFailure error={trash.error} />
            <Button
              variant="destructive"
              pending={trash.isPending}
              disabled={state.hasUnsavedChanges}
              onClick={() =>
                trash.mutate(
                  { id: note.file.id },
                  {
                    onSuccess() {
                      navigatePath(formatCloudPath({ section: "notes", noteId: null }));
                    },
                  },
                )
              }
            >
              Move to Trash
            </Button>
            {state.hasUnsavedChanges && (
              <p className="text-xs text-muted-foreground">
                Wait for your changes to save or export them first.
              </p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameNoteDialog({
  note,
  open,
  onOpenChange,
}: {
  note: Note;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const rename = useRenameNote();

  // Capture the base alongside the draft. A refresh must not silently move its conflict fence.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename note</DialogTitle>
          <DialogDescription>
            A conflicting title is never overwritten. Keep your draft and try again after reviewing
            the current title.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <RenameNoteForm
            key={String(open)}
            note={note}
            rename={rename}
            onSaved={() => onOpenChange(false)}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RenameNoteForm({
  note,
  rename,
  onSaved,
}: {
  note: Note;
  rename: ReturnType<typeof useRenameNote>;
  onSaved(): void;
}) {
  const [base] = useState(note.file.name);

  return (
    <Form
      onValues={(values) =>
        rename.mutate(
          { id: note.file.id, name: String(values.get("name")), expectedName: base },
          { onSuccess: onSaved },
        )
      }
    >
      <Input
        name="name"
        aria-label="Note title"
        defaultValue={base}
        required
        maxLength={255}
        autoFocus
      />
      <MutationFailure error={rename.error} />
      <Button type="submit" pending={rename.isPending}>
        Rename
      </Button>
    </Form>
  );
}

function NoteHistoryDialog({
  id,
  session,
  open,
  onOpenChange,
}: {
  id: string;
  session: ReturnType<typeof createCollaborationSession>;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const history = useNoteHistory(id, open, cursor);
  const checkpoint = useCheckpointNote();
  const restore = useRestoreNoteCheckpoint();
  const state = useStoreValue(session);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Saved checkpoints are kept with this note. Restoring preserves the current version and
            pauses open editors.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Button
            variant="outline"
            pending={checkpoint.isPending}
            disabled={state.hasUnsavedChanges || state.status !== "saved"}
            onClick={() => checkpoint.mutate({ id })}
          >
            Save checkpoint
          </Button>
          <MutationFailure error={checkpoint.error ?? restore.error} />
          {history.data === undefined ? (
            <QueryWaiting resource={history} pending={<Spinner />} />
          ) : null}
          {history.data?.items.length === 0 && (
            <p className="text-sm text-muted-foreground">No checkpoints yet.</p>
          )}
          {history.data?.items.map((version) => (
            <div
              key={version.id}
              className="flex items-center justify-between gap-3 border-b border-border py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{version.name}</p>
                <time className="text-xs text-muted-foreground">
                  {new Date(version.createdAt).toLocaleString()}
                </time>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={state.hasUnsavedChanges}
                pending={restore.isPending}
                onClick={() =>
                  restore.mutate(
                    { id, checkpointId: version.id },
                    {
                      onSuccess() {
                        onOpenChange(false);
                        void session.flush();
                      },
                    },
                  )
                }
              >
                Restore
              </Button>
            </div>
          ))}
          {history.data?.nextCursor && (
            <Button variant="ghost" size="sm" onClick={() => setCursor(history.data!.nextCursor!)}>
              Older checkpoints
            </Button>
          )}
          {cursor !== undefined && (
            <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
              Latest checkpoints
            </Button>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

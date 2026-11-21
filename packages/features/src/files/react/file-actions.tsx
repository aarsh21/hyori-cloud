import { normalizeClientError } from "@hyori-cloud/client-sdk";
import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { createContext, useContext, useId, useRef, useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { DeferredDialog } from "@hyori-cloud/ui/components/deferred-dialog";
import { useDisposeOnUnmount } from "@hyori-cloud/ui/hooks/use-dispose-on-unmount";
import { loadFileDialogs } from "#features/files/react/file-dialog-loaders.ts";
import { DOWNLOAD_MUTATION_KEY, useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useRestoreFile, useTrashFile } from "#features/files/react/use-file-mutations.ts";
import { usePendingItemActions } from "#features/files/react/use-pending-item-actions.ts";
import { useFileActionErrors } from "#features/files/react/use-file-action-errors.ts";
import { isMediaType } from "#features/shared/format.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";

const loadDialogs = async () => (await loadFileDialogs()).FileDialogs;

export type FileDialog =
  | { readonly kind: "createFolder" }
  | { readonly kind: "rename"; readonly id: string }
  | { readonly kind: "replace"; readonly id: string }
  // Moving removes the row from this listing while the dialog is still waiting on the result, so
  // this dialog holds its own target instead of looking it up.
  | { readonly kind: "move"; readonly entry: FileEntry }
  | { readonly kind: "share"; readonly id: string }
  | { readonly kind: "versions"; readonly id: string }
  | { readonly kind: "viewer"; readonly id: string }
  | { readonly kind: "preview"; readonly id: string };

export type OpenFileDialog = {
  readonly dialog: FileDialog;
  readonly open: boolean;
  readonly folderId: string | null;
};

type FileActions = {
  readonly openDialog: (dialog: FileDialog) => void;
  readonly openFile: (entry: FileEntry) => void;
  readonly download: (id: string) => void;
  readonly trash: (entry: FileEntry) => void;
};

type ActionFailure = {
  readonly error: CloudError | null;
  readonly dismiss: () => void;
  readonly recovered: () => void;
};

const FileActionsContext = createContext<FileActions | null>(null);
const ActionFailureContext = createContext<ActionFailure | null>(null);
const PendingActionsContext = createContext<ReadonlySet<string>>(new Set());

function targetIsGone(dialog: FileDialog, entries: readonly FileEntry[]) {
  if (dialog.kind === "createFolder" || dialog.kind === "move") return false;

  return !entries.some((entry) => entry.id === dialog.id);
}

function dialogTitle(dialog: FileDialog) {
  switch (dialog.kind) {
    case "createFolder":
      return "New folder";
    case "viewer":
    case "preview":
      return "Preview";
    case "replace":
    case "share":
    case "move":
    case "rename":
    case "versions":
      return "File details";
  }
}

/**
 * One owner for dialogs and row actions, so hundreds of rows share them instead of each mounting
 * their own. Dialogs keep their kind and target while closing so exit transitions have content.
 */
export function FileActionsProvider({
  entries,
  folderId,
  children,
}: {
  entries: readonly FileEntry[];
  folderId: string | null;
  children: ReactNode;
}) {
  const [active, setActive] = useState<OpenFileDialog | null>(null);
  const { mutation } = useClientSDK();
  const scope = { fileActionsOwner: useId() };
  const download = useDownloadFile(scope);
  const trash = useTrashFile(scope);
  // Unscoped: an Undo's failure belongs to its toast, which names the file and can try again.
  const restore = useRestoreFile();
  const { mutate: requestDownload } = download;
  const { mutateAsync: requestTrash } = trash;
  const { mutateAsync: requestRestore } = restore;
  const failure = useFileActionErrors(scope);
  const { pendingIds, isDownloading, isTrashing } = usePendingItemActions();
  const ownerMounted = useRef(true);

  useDisposeOnUnmount(() => {
    ownerMounted.current = false;
  });

  // Cleared rather than hidden: a dialog left behind in another folder, or for a target that's gone,
  // must not reopen by itself when that folder or item comes back.
  if (active !== null && (active.folderId !== folderId || targetIsGone(active.dialog, entries))) {
    setActive(null);
  }

  function openDialog(dialog: FileDialog) {
    setActive({ dialog, open: true, folderId });
  }

  function downloadOnce(id: string) {
    if (isDownloading(id)) return;
    failure.clearFor(DOWNLOAD_MUTATION_KEY, id);
    requestDownload({ id });
  }

  function restoreOnce(entry: FileEntry) {
    void requestRestore({ id: entry.id }).catch((error) => {
      toast.error(`Couldn’t restore “${entry.name}”`, {
        description: describeCloudError(normalizeClientError(error)).title,
        action: { label: "Try again", onClick: () => restoreOnce(entry) },
      });
    });
  }

  const actions: FileActions = {
    openDialog,
    download: downloadOnce,
    openFile(entry) {
      // Media opens in the viewer; every other file opens in Quick preview, where download stays
      // one action away instead of being what a click silently does.
      if (isMediaType(entry.mimeType)) openDialog({ kind: "viewer", id: entry.id });
      else openDialog({ kind: "preview", id: entry.id });
    },
    trash(entry) {
      if (isTrashing(entry.id)) return;
      failure.clearFor(mutation.files.trash.key, entry.id);

      void requestTrash({ id: entry.id })
        .then(() =>
          toast(`Moved “${entry.name}” to Trash`, {
            duration: 6000,
            action: { label: "Undo", onClick: () => restoreOnce(entry) },
          }),
        )
        .catch(() => {
          // The page's notice already says this while it's on screen. Only someone who has moved on
          // needs telling here, and they also need to know which file it was.
          if (!ownerMounted.current) toast.error(`Couldn’t move “${entry.name}” to Trash`);
        });
    },
  };

  return (
    <FileActionsContext value={actions}>
      <ActionFailureContext value={failure}>
        <PendingActionsContext value={pendingIds}>{children}</PendingActionsContext>
        {active !== null ? (
          <DeferredDialog
            key={`${active.dialog.kind}:${"id" in active.dialog ? active.dialog.id : ""}`}
            load={loadDialogs}
            title={dialogTitle(active.dialog)}
            open={active.open}
            onClose={() => setActive({ ...active, open: false })}
            props={{
              active,
              entries,
              folderId,
              onSelect: openDialog,
              onClose: () => setActive({ ...active, open: false }),
            }}
          />
        ) : null}
      </ActionFailureContext>
    </FileActionsContext>
  );
}

export function useFileActions(): FileActions {
  const actions = useContext(FileActionsContext);

  if (actions === null) throw new Error("useFileActions requires FileActionsProvider.");

  return actions;
}

export function useFileActionPending(id: string): boolean {
  return useContext(PendingActionsContext).has(id);
}

export function useFileActionFailure(): ActionFailure {
  const failure = useContext(ActionFailureContext);

  if (failure === null) throw new Error("useFileActionFailure requires FileActionsProvider.");

  return failure;
}

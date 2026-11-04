import type { FileEntry } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { createContext, use, useId, useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { FileDialogs } from "#features/files/react/file-dialogs.tsx";
import { DOWNLOAD_MUTATION_KEY, useDownloadFile } from "#features/files/react/use-download-file.ts";
import { useRestoreFile, useTrashFile } from "#features/files/react/use-file-mutations.ts";
import { usePendingItemActions } from "#features/files/react/use-pending-item-actions.ts";
import { useFileActionErrors } from "#features/files/react/use-file-action-errors.ts";
import { isMediaType } from "#features/shared/format.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";

export type FileDialog =
  | { readonly kind: "createFolder" }
  | { readonly kind: "rename"; readonly id: string }
  // Moving removes the row from this listing while the dialog is still waiting on the result, so
  // this dialog holds its own target instead of looking it up.
  | { readonly kind: "move"; readonly entry: FileEntry }
  | { readonly kind: "share"; readonly id: string }
  | { readonly kind: "versions"; readonly id: string }
  | { readonly kind: "viewer"; readonly id: string };

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
  const restore = useRestoreFile(scope);
  const { mutate: requestDownload } = download;
  const { mutateAsync: requestTrash } = trash;
  const { mutateAsync: requestRestore } = restore;
  const failure = useFileActionErrors(scope);
  const { pendingIds, isDownloading, isTrashing } = usePendingItemActions();

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
    failure.clearFor(mutation.files.restore.key, entry.id);
    void requestRestore({ id: entry.id }).catch(() =>
      toast.error(`Couldn’t restore “${entry.name}”`, {
        action: { label: "Try again", onClick: () => restoreOnce(entry) },
      }),
    );
  }

  const actions: FileActions = {
    openDialog,
    download: downloadOnce,
    openFile(entry) {
      if (isMediaType(entry.mimeType)) openDialog({ kind: "viewer", id: entry.id });
      else downloadOnce(entry.id);
    },
    trash(entry) {
      if (isTrashing(entry.id)) return;
      failure.clearFor(mutation.files.trash.key, entry.id);

      void requestTrash({ id: entry.id })
        .then(() =>
          toast(`Moved “${entry.name}” to Trash`, {
            action: { label: "Undo", onClick: () => restoreOnce(entry) },
          }),
        )
        .catch(() => toast.error(`Couldn’t move “${entry.name}” to Trash`));
    },
  };

  return (
    <FileActionsContext value={actions}>
      <ActionFailureContext value={failure}>
        <PendingActionsContext value={pendingIds}>{children}</PendingActionsContext>
        <FileDialogs
          active={active}
          entries={entries}
          folderId={folderId}
          onSelect={openDialog}
          onClose={() => setActive(active === null ? null : { ...active, open: false })}
        />
      </ActionFailureContext>
    </FileActionsContext>
  );
}

export function useFileActions(): FileActions {
  const actions = use(FileActionsContext);

  if (actions === null) throw new Error("useFileActions requires FileActionsProvider.");

  return actions;
}

export function useFileActionPending(id: string): boolean {
  return use(PendingActionsContext).has(id);
}

export function useFileActionFailure(): ActionFailure {
  const failure = use(ActionFailureContext);

  if (failure === null) throw new Error("useFileActionFailure requires FileActionsProvider.");

  return failure;
}

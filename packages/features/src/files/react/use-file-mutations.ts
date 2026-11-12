import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";
import type { FileActionScope } from "#features/files/react/file-action-scope.ts";

// Thin selections of operations. Invalidation stays in the SDK's central mutation defaults.

export function useCreateFolder() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.createFolder.mutationOptions());
}

export function useRenameFile() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.rename.mutationOptions());
}

export function useMoveFile() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.move.mutationOptions());
}

export function useTrashFile(scope?: FileActionScope) {
  const { mutation } = useClientSDK();

  return useMutation({ ...mutation.files.trash.mutationOptions(), meta: scope });
}

export function useRestoreFile(scope?: FileActionScope) {
  const { mutation } = useClientSDK();

  return useMutation({ ...mutation.files.restore.mutationOptions(), meta: scope });
}

export function useRestoreVersion() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.restoreVersion.mutationOptions());
}

export function useDeletePermanently() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.deletePermanently.mutationOptions());
}

export function useEmptyTrash() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.emptyTrash.mutationOptions());
}

export function useDeleteVersion() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.files.deleteVersion.mutationOptions());
}

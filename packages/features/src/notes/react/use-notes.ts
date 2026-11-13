import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation, useQuery } from "@hyori-cloud/lib/query";
import type { InputOf, RPC } from "@hyori-cloud/client-sdk";

export function useNotes(input: InputOf<RPC["notes"]["list"]>) {
  const { query } = useClientSDK();

  return useQuery({ ...query.notes.list.getOptions(input), refetchInterval: 10_000 });
}

export function useNote(id: string) {
  const { query } = useClientSDK();

  return useQuery({ ...query.notes.get.getOptions({ id }), refetchInterval: 5000 });
}

export function useCreateNote() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.notes.create.mutationOptions());
}

export function useRenameNote() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.notes.rename.mutationOptions());
}

export function useFavoriteNote() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.notes.favorite.mutationOptions());
}

export function useNoteHistory(id: string, enabled: boolean, cursor: string | undefined) {
  const { query } = useClientSDK();

  return useQuery({ ...query.notes.history.getOptions({ id, cursor }), enabled });
}

export function useCheckpointNote() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.notes.checkpoint.mutationOptions());
}

export function useRestoreNoteCheckpoint() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.notes.restoreCheckpoint.mutationOptions());
}

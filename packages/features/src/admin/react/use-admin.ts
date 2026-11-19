import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";
import { useCursorPages } from "#features/shared/react/use-cursor-pages.ts";

export function useAdminUsers() {
  const { query, rpc } = useClientSDK();

  return useCursorPages(query.admin.users, rpc.admin.users, {}, undefined, (pages) =>
    pages.some((page) => page.items.some((user) => user.status === "deleting")) ? 5000 : false,
  );
}

export function useCreateUser() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.admin.createUser.mutationOptions());
}

export function useCreateInvite() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.admin.createInvite.mutationOptions());
}

export function useSetQuota() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.admin.setQuota.mutationOptions());
}

export function useDeleteUser() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.admin.deleteUser.mutationOptions());
}

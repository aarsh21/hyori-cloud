import type { Query, ResourceOf } from "@hyori-cloud/client-sdk/react";
import type { Share, ShareRole } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQueryClient } from "@hyori-cloud/lib/query";

/** One item's cached share list, as `shares.list` hands it back. */
export type SharesPage = NonNullable<ResourceOf<Query["shares"]["list"]>["data"]>;

/** Replace a share in place, or append it when it isn't listed yet. */
export function upsertShare(page: SharesPage, share: Share): SharesPage {
  const items = [...page.items];
  const index = items.findIndex((existing) => existing.id === share.id);

  if (index === -1) items.push(share);
  else items[index] = share;

  return { items };
}

export function patchShareRole(page: SharesPage, id: string, role: ShareRole): SharesPage {
  return { items: page.items.map((share) => (share.id === id ? { ...share, role } : share)) };
}

export function withoutShare(page: SharesPage, id: string): SharesPage {
  return { items: page.items.filter((share) => share.id !== id) };
}

/**
 * A share granted seconds ago renders as itself while the request is in flight: the picker writes
 * it into the cache with this id, then replaces it with the server's share on success and removes
 * it on failure.
 */
const PENDING_SHARE_PREFIX = "pending:";

export function pendingShareId(recipientId: string): string {
  return `${PENDING_SHARE_PREFIX}${recipientId}`;
}

export function isPendingShare(share: Share): boolean {
  return share.id.startsWith(PENDING_SHARE_PREFIX);
}

/**
 * Optimistic edits to one item's cached share list. `snapshot()` stops a refetch from racing the
 * edit and hands back the page to restore on failure; `amend()` applies the edit functionally, so
 * concurrent edits each see the other's result.
 */
export function useSharesCache(itemId: string) {
  const { query } = useClientSDK();
  const queryClient = useQueryClient();
  const key = query.shares.list.getKey({ itemId });

  return {
    async snapshot(): Promise<SharesPage | undefined> {
      await queryClient.cancelQueries({ queryKey: key });

      return queryClient.getQueryData<SharesPage>(key);
    },
    restore(page: SharesPage | undefined) {
      queryClient.setQueryData<SharesPage>(key, page);
    },
    amend(edit: (page: SharesPage) => SharesPage) {
      queryClient.setQueryData<SharesPage>(key, (current) => edit(current ?? { items: [] }));
    },
  };
}

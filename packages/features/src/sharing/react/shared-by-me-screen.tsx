import type { OutputOf, RPC, ShareRole } from "@hyori-cloud/client-sdk";
import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { FolderOpen, Share2, Users } from "@hyori-cloud/lib/icons";
import { useInfiniteQuery, useQuery, useQueryClient } from "@hyori-cloud/lib/query";
import { useState } from "@hyori-cloud/lib/react";
import {
  PageBar,
  PageBarActions,
  PageBody,
  PageSection,
  PageTitle,
} from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import { DropdownMenuItem } from "@hyori-cloud/ui/components/dropdown-menu";
import { ItemActionMenu } from "@hyori-cloud/ui/components/item-action-menu";
import {
  ItemActionSlot,
  ItemButton,
  ItemName,
  ItemNavigation,
  ItemTable,
  ItemTableBody,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableRow,
  ItemTableSkeleton,
} from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { VirtualItems } from "@hyori-cloud/ui/components/virtual-items";
import { formatCloudPath } from "#features/cloud/cloud-path.ts";
import { useCloudNavigation } from "#features/cloud/react/cloud-navigation.tsx";
import { FileTypeIcon } from "#features/files/react/file-type-icon.tsx";
import { formatDateTime, formatRecentDate } from "#features/shared/format.ts";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";
import { outgoingSharesOptions } from "#features/sharing/outgoing-shares.ts";
import { ShareDialog } from "#features/sharing/react/share-dialog.tsx";
import { SharedNav } from "#features/sharing/react/shared-nav.tsx";

type Outgoing = OutputOf<RPC["shares"]["outgoing"]>["items"][number];

const ROLE_LABELS: Record<ShareRole, string> = {
  viewer: "Viewer",
  contributor: "Contributor",
  editor: "Editor",
};

/** A link has no person behind it; a person whose account is gone still had a grant. */
function audience({ share }: Outgoing) {
  if (share.public) return "Anyone with the link";

  return share.recipient?.name ?? "A removed account";
}

function access(row: Outgoing) {
  return row.expired ? `${ROLE_LABELS[row.share.role]} · Expired` : ROLE_LABELS[row.share.role];
}

/** The item's kind is all a row knows of it, which is enough for the glyph. */
function rowIcon(row: Outgoing) {
  return <FileTypeIcon entry={{ kind: row.itemKind, mimeType: "" }} />;
}

export function SharedByMeScreen() {
  const sdk = useClientSDK();
  const shares = useInfiniteQuery(outgoingSharesOptions(sdk));
  // The share dialog needs the item itself, which is read when a row is chosen.
  const [managing, setManaging] = useState<{ itemId: string; open: boolean } | null>(null);
  const rows = shares.data?.pages.flatMap((page) => page.items) ?? [];

  function renderBody() {
    if (shares.data === undefined) {
      return <QueryWaiting resource={shares} pending={<ItemTableSkeleton />} />;
    }

    return (
      <>
        {shares.isRefetchError ? (
          <RefreshFailure error={shares.error} onRetry={() => shares.refetch()} />
        ) : null}
        {rows.length === 0 ? (
          <NothingShared />
        ) : (
          <ItemNavigation itemKeys={rows.map((row) => row.share.id)} layout="list">
            <ItemTable className="[--item-columns:minmax(0,1fr)_2.25rem] @2xl:[--item-columns:minmax(0,1fr)_minmax(0,13rem)_9rem_9rem_2.25rem]">
              <ItemTableHeader>
                <ItemTableHeaderCell>Name</ItemTableHeaderCell>
                <ItemTableHeaderCell>Shared with</ItemTableHeaderCell>
                <ItemTableHeaderCell>Access</ItemTableHeaderCell>
                <ItemTableHeaderCell>Shared</ItemTableHeaderCell>
                <ItemTableHeaderCell />
              </ItemTableHeader>
              <VirtualItems
                items={rows}
                itemKey={(row) => row.share.id}
                list={<ItemTableBody aria-label="Shared by me" />}
              >
                {(row) => (
                  <OutgoingRow
                    row={row}
                    onManage={() => setManaging({ itemId: row.share.itemId, open: true })}
                  />
                )}
              </VirtualItems>
            </ItemTable>
          </ItemNavigation>
        )}
        <LoadMore pages={shares} />
      </>
    );
  }

  return (
    <>
      <PageBar>
        <PageTitle>Shared by me</PageTitle>
        <PageBarActions>
          <SharedNav />
        </PageBarActions>
      </PageBar>
      <PageBody scrollRestorationId="shared-by-me">
        <PageSection>
          {managing === null ? null : (
            <ManageSharing
              key={managing.itemId}
              itemId={managing.itemId}
              open={managing.open}
              onOpenChange={(open) => setManaging({ ...managing, open })}
            />
          )}
          {renderBody()}
        </PageSection>
      </PageBody>
    </>
  );
}

function OutgoingRow({ row, onManage }: { row: Outgoing; onManage: () => void }) {
  const hydrated = useHydrated();
  const { query } = useClientSDK();
  const queryClient = useQueryClient();
  const { navigatePath } = useCloudNavigation();
  const shared = hydrated ? formatRecentDate(row.createdAt) : "—";

  // Choosing a row needs the item; reading it on intent lets the dialog open without a wait.
  const prefetch = () =>
    void queryClient.prefetchQuery(query.files.get.getOptions({ id: row.share.itemId }));

  return (
    <ItemTableRow itemKey={row.share.id}>
      <ItemTableCell className="flex">
        <ItemButton
          aria-label={`Manage sharing for ${row.itemName}`}
          onPointerEnter={prefetch}
          onFocus={prefetch}
          onClick={onManage}
        >
          <ItemName icon={rowIcon(row)} meta={`${audience(row)} · ${access(row)}`}>
            {row.itemName}
          </ItemName>
        </ItemButton>
      </ItemTableCell>
      <ItemTableDetailCell className="truncate" title={row.share.recipient?.email}>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {row.share.public ? null : <Users aria-hidden className="size-3.5 shrink-0" />}
          <span className="truncate">{audience(row)}</span>
        </span>
      </ItemTableDetailCell>
      <ItemTableDetailCell className={row.expired ? "text-warning" : undefined}>
        {access(row)}
      </ItemTableDetailCell>
      <ItemTableDetailCell title={hydrated ? formatDateTime(row.createdAt) : undefined}>
        {shared}
      </ItemTableDetailCell>
      <ItemTableCell className="overflow-visible">
        <ItemActionSlot>
          <ItemActionMenu label={`Actions for ${row.itemName}`}>
            <DropdownMenuItem onPointerEnter={prefetch} onClick={onManage}>
              <Share2 />
              Manage sharing…
            </DropdownMenuItem>
            {row.itemKind === "folder" ? (
              <DropdownMenuItem
                onClick={() =>
                  navigatePath(formatCloudPath({ section: "files", folderId: row.share.itemId }))
                }
              >
                <FolderOpen />
                Open folder
              </DropdownMenuItem>
            ) : null}
          </ItemActionMenu>
        </ItemActionSlot>
      </ItemTableCell>
    </ItemTableRow>
  );
}

/** Opens once the item is read; a failed read says so where the dialog would have been. */
function ManageSharing({
  itemId,
  open,
  onOpenChange,
}: {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { query } = useClientSDK();
  const item = useQuery(query.files.get.getOptions({ id: itemId }));

  if (item.data === undefined) return <MutationFailure error={item.error} />;

  return <ShareDialog entry={item.data} open={open} onOpenChange={onOpenChange} />;
}

function NothingShared() {
  const { navigatePath } = useCloudNavigation();

  return (
    <RegionState
      icon={<Share2 />}
      title="You haven’t shared anything"
      description="Share a file or folder from its menu, and it appears here."
      action={
        <Button
          variant="outline"
          onClick={() => navigatePath(formatCloudPath({ section: "files", folderId: null }))}
        >
          Go to Files
        </Button>
      }
    />
  );
}

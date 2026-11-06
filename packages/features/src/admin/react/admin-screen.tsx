import type { OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { ShieldCheck, UserPlus, Users } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import {
  PageBar,
  PageBarActions,
  PageBody,
  PageSection,
  PageTitle,
} from "@hyori-cloud/ui/components/app-shell";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  ItemTable,
  ItemTableBody,
  ItemTableHeader,
  ItemTableHeaderCell,
  ItemTableSkeleton,
} from "@hyori-cloud/ui/components/item-collection";
import { RegionState } from "@hyori-cloud/ui/components/region-state";
import { Text } from "@hyori-cloud/ui/components/text";
import { AdminUserRow } from "#features/admin/react/admin-user-row.tsx";
import { CreateUserDialog } from "#features/admin/react/create-user-dialog.tsx";
import { DeleteUserDialog } from "#features/admin/react/delete-user-dialog.tsx";
import { InviteDialog } from "#features/admin/react/invite-dialog.tsx";
import { QuotaDialog } from "#features/admin/react/quota-dialog.tsx";
import { useAdminUsers } from "#features/admin/react/use-admin.ts";
import { useCurrentUser } from "#features/auth/react/current-user.tsx";
import { LoadMore } from "#features/shared/react/load-more.tsx";
import { QueryWaiting } from "#features/shared/react/query-waiting.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";

export type AdminUser = OutputOf<RPC["admin"]["users"]>["items"][number];

type AdminDialog =
  | { readonly kind: "create" }
  | { readonly kind: "invite" }
  | { readonly kind: "quota"; readonly userId: string }
  | { readonly kind: "delete"; readonly userId: string };

export function AdminScreen() {
  const user = useCurrentUser();

  if (user.role !== "admin") {
    return (
      <RegionState
        icon={<ShieldCheck />}
        title="Admins only"
        description="Ask an administrator of this server if you need a change to your account."
      />
    );
  }

  return <AdminUsers />;
}

function AdminUsers() {
  const users = useAdminUsers();
  const [active, setActive] = useState<{ dialog: AdminDialog; open: boolean } | null>(null);
  const items = users.data?.pages.flatMap((page) => page.items) ?? [];

  function renderBody() {
    if (users.data === undefined) {
      return <QueryWaiting resource={users} pending={<ItemTableSkeleton rows={4} />} />;
    }

    return (
      <>
        {users.isRefetchError ? (
          <RefreshFailure error={users.error} onRetry={() => users.refetch()} />
        ) : null}
        {items.length === 0 ? (
          <RegionState icon={<Users />} title="No users" />
        ) : (
          <ItemTable className="[--item-columns:minmax(0,1fr)_2.25rem] @2xl:[--item-columns:minmax(0,1fr)_14rem_2.25rem]">
            <ItemTableHeader>
              <ItemTableHeaderCell>Name</ItemTableHeaderCell>
              <ItemTableHeaderCell>Storage</ItemTableHeaderCell>
              <ItemTableHeaderCell />
            </ItemTableHeader>
            <ItemTableBody aria-label="Users">
              {items.map((item) => (
                <AdminUserRow
                  key={item.id}
                  user={item}
                  onSetQuota={() =>
                    setActive({ dialog: { kind: "quota", userId: item.id }, open: true })
                  }
                  onDelete={() =>
                    setActive({ dialog: { kind: "delete", userId: item.id }, open: true })
                  }
                />
              ))}
            </ItemTableBody>
          </ItemTable>
        )}
        <LoadMore pages={users} />
        <Text size="xs" tone="muted" className="px-2">
          Admins see storage totals only. They can’t browse other people’s files.
        </Text>
      </>
    );
  }

  return (
    <>
      <PageBar>
        <PageTitle>Users</PageTitle>
        <PageBarActions>
          <Button
            variant="outline"
            onClick={() => setActive({ dialog: { kind: "invite" }, open: true })}
          >
            Invite
          </Button>
          <Button onClick={() => setActive({ dialog: { kind: "create" }, open: true })}>
            <UserPlus aria-hidden />
            Add user
          </Button>
        </PageBarActions>
      </PageBar>
      <PageBody>
        <PageSection>{renderBody()}</PageSection>
      </PageBody>
      {active === null ? null : (
        <AdminDialogs
          dialog={active.dialog}
          open={active.open}
          users={items}
          onClose={() => setActive({ ...active, open: false })}
        />
      )}
    </>
  );
}

function AdminDialogs({
  dialog,
  open,
  users,
  onClose,
}: {
  dialog: AdminDialog;
  open: boolean;
  users: readonly AdminUser[];
  onClose: () => void;
}) {
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  switch (dialog.kind) {
    case "create":
      return <CreateUserDialog open={open} onOpenChange={onOpenChange} />;
    case "invite":
      return <InviteDialog open={open} onOpenChange={onOpenChange} />;
    case "quota": {
      const target = users.find((candidate) => candidate.id === dialog.userId);

      return target === undefined ? null : (
        <QuotaDialog key={target.id} user={target} open={open} onOpenChange={onOpenChange} />
      );
    }

    case "delete": {
      const target = users.find((candidate) => candidate.id === dialog.userId);

      return target === undefined ? null : (
        <DeleteUserDialog key={target.id} user={target} open={open} onOpenChange={onOpenChange} />
      );
    }
  }

  dialog satisfies never;

  return null;
}

import { HardDrive, KeyRound, Trash2, User as UserIcon } from "@hyori-cloud/lib/icons";
import { DropdownMenuItem, DropdownMenuSeparator } from "@hyori-cloud/ui/components/dropdown-menu";
import { ItemActionMenu } from "@hyori-cloud/ui/components/item-action-menu";
import {
  ItemActionSlot,
  ItemName,
  ItemTableCell,
  ItemTableDetailCell,
  ItemTableRow,
} from "@hyori-cloud/ui/components/item-collection";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText } from "@hyori-cloud/ui/components/text";
import type { AdminUser } from "#features/admin/react/admin-screen.tsx";
import { formatUsage } from "#features/shared/format.ts";

export function AdminUserRow({
  user,
  onSetQuota,
  onResetPassword,
  onDelete,
}: {
  user: AdminUser;
  onSetQuota: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
}) {
  const usage = formatUsage(user.usedBytes, user.quotaBytes);
  const deleting = user.status === "deleting";

  return (
    <ItemTableRow itemKey={user.id}>
      <ItemTableCell className="flex items-center gap-2">
        <ItemName
          icon={<UserIcon aria-hidden />}
          meta={
            deleting ? (
              "Deleting account…"
            ) : (
              <span className="flex min-w-0 gap-1">
                <span className="truncate">{user.email}</span>
                <span className="shrink-0">· {usage}</span>
              </span>
            )
          }
        >
          {user.name}
        </ItemName>
        <InlineText tone="muted" truncate className="hidden min-w-0 flex-1 @2xl:inline">
          {user.email}
        </InlineText>
        {user.role === "admin" ? <Tag>Admin</Tag> : null}
      </ItemTableCell>
      <ItemTableDetailCell>{deleting ? "Deleting account…" : usage}</ItemTableDetailCell>
      <ItemTableCell className="overflow-visible">
        {deleting ? null : (
          <ItemActionSlot>
            <ItemActionMenu label={`Actions for ${user.name}`}>
              <DropdownMenuItem onClick={onSetQuota}>
                <HardDrive />
                Set storage quota…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onResetPassword}>
                <KeyRound />
                Reset password…
              </DropdownMenuItem>
              {user.role === "admin" ? null : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 />
                    Delete account and files…
                  </DropdownMenuItem>
                </>
              )}
            </ItemActionMenu>
          </ItemActionSlot>
        )}
      </ItemTableCell>
    </ItemTableRow>
  );
}

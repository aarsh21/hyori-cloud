import { HardDrive, Trash2, User as UserIcon } from "@hyori-cloud/lib/icons";
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
import { InlineText, Row } from "@hyori-cloud/ui/components/text";
import type { AdminUser } from "#features/admin/react/admin-screen.tsx";
import { formatUsage } from "#features/shared/format.ts";

export function AdminUserRow({
  user,
  onSetQuota,
  onDelete,
}: {
  user: AdminUser;
  onSetQuota: () => void;
  onDelete: () => void;
}) {
  const usage = formatUsage(user.usedBytes, user.quotaBytes);
  const deleting = user.status === "deleting";

  return (
    <ItemTableRow itemKey={user.id}>
      <ItemTableCell className="flex items-center gap-2">
        <ItemName
          className="flex-none shrink"
          icon={<UserIcon aria-hidden />}
          meta={deleting ? "Deleting account…" : `${user.email} · ${usage}`}
        >
          {user.name}
        </ItemName>
        <Row className="min-w-0 gap-2">
          <InlineText tone="muted" truncate className="hidden @2xl:inline">
            {user.email}
          </InlineText>
          {user.role === "admin" ? <Tag>Admin</Tag> : null}
        </Row>
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

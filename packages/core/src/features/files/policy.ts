import { Match, Schema } from "@hyori-cloud/lib/effect";
import { Name } from "#core/features/auth/api/schema";
import type { Transaction } from "@hyori-cloud/lib/surreal";
import { UserRecord } from "#core/features/auth/db";
import type { Access, FileEntry, ShareRole } from "#core/features/files/api/schema";
import { ItemRecord } from "#core/features/files/db";
import { ShareRecord } from "#core/features/shares/db";
import { active, type Actor, fail, requireUser } from "#core/runtime";

const rank = { viewer: 1, contributor: 2, editor: 3 } as const;

export async function sharesFor(transaction: Transaction, actor: Actor): Promise<ShareRecord[]> {
  const shares = await transaction.find(
    ShareRecord,
    "share",
    "(recipientId = $user OR key IN $shares) AND revokedAt = NULL AND (expiresAt = NULL OR expiresAt > $now) AND issuerId IN (SELECT VALUE key FROM hc_user WHERE status = $active)",
    {
      user: actor.user?.key ?? "__none__",
      shares: actor.shareIds,
      now: new Date().toISOString(),
      active: "active",
    },
    1001,
  );

  if (shares.length > 1000)
    fail("resource.conflict", "Share scope exceeds this release’s supported limit");

  return shares;
}

export function accessFor(
  item: ItemRecord,
  actor: Actor,
  shares: readonly ShareRecord[],
): typeof Access.Type {
  const isOwner = actor.user?.key === item.ownerId;
  let role: ShareRole | null = null;

  if (!item.trashedAt)
    for (const share of shares) {
      if (
        !share.revokedAt &&
        active(share.expiresAt) &&
        (share.itemId === item.key || item.ancestorIds.includes(share.itemId)) &&
        (role === null || rank[share.role] > rank[role])
      )
        role = share.role;
    }

  return {
    role,
    isOwner,
    canDownload: isOwner || role !== null,
    canUpload:
      !item.trashedAt &&
      item.kind === "folder" &&
      (isOwner || role === "contributor" || role === "editor"),
    canEdit: !item.trashedAt && (isOwner || role === "editor"),
    canDelete: isOwner,
    canShare: isOwner && !item.trashedAt,
  };
}

export function projectItem(
  item: ItemRecord,
  actor: Actor,
  shares: readonly ShareRecord[],
): FileEntry {
  return {
    id: item.key,
    name: item.name,
    kind: item.kind,
    parentId: item.parentId,
    ownerId: item.ownerId,
    size: item.size,
    mimeType: item.mimeType,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    trashedAt: item.trashedAt,
    access: accessFor(item, actor, shares),
  };
}

export async function authorizeItem(
  transaction: Transaction,
  actor: Actor,
  id: string,
  action: "read" | "edit" | "upload" | "owner",
  allowTrash = false,
) {
  const item = await transaction.get(ItemRecord, "item", id);

  if (!item || (item.trashedAt && !allowTrash)) fail("resource.notFound", "Item not found");
  const owner = await transaction.get(UserRecord, "user", item.ownerId);

  if (owner?.status !== "active") fail("resource.notFound", "Item not found");
  const shares = await sharesFor(transaction, actor);
  const access = accessFor(item, actor, shares);

  const permitted = Match.value(action).pipe(
    Match.when("owner", () => access.isOwner),
    Match.when("edit", () => access.canEdit),
    Match.when("upload", () => access.canUpload),
    Match.when("read", () => access.canDownload),
    Match.exhaustive,
  );

  if (!permitted) fail("access.denied", "You do not have access to this item");

  return { item, owner, shares, access };
}

export async function destination(transaction: Transaction, actor: Actor, parentId: string | null) {
  if (parentId === null) return { owner: requireUser(actor), parent: null };
  const { item, owner } = await authorizeItem(transaction, actor, parentId, "upload");

  if (item.kind !== "folder") fail("input.invalid", "Destination must be a folder");

  if (item.ancestorIds.length >= 63) fail("input.invalid", "Maximum folder depth reached");

  return { owner, parent: item };
}

export function validateName(name: string): string {
  const value = name.trim().normalize("NFC");

  if (
    !Schema.is(Name)(value) ||
    /[\uD800-\uDFFF]/u.test(value) ||
    value === "." ||
    value === ".." ||
    /[/\\]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    fail("input.invalid", "Use 1–255 characters without path separators or control characters");

  return value;
}

export async function availableName(
  transaction: Transaction,
  ownerId: string,
  parentId: string | null,
  name: string,
  except?: string,
): Promise<void> {
  const matches = await transaction.find(
    ItemRecord,
    "item",
    "ownerId = $owner AND parentId = $parent AND name = $name AND trashedAt = NULL AND key != $except",
    { owner: ownerId, parent: parentId, name, except: except ?? "" },
    1,
  );

  if (matches.length) fail("resource.conflict", "An item with this name already exists");
}

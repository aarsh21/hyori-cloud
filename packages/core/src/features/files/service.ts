import { newId } from "@hyori-cloud/lib/crypto";
import type { Transaction } from "@hyori-cloud/lib/surreal";
import type {
  CreateFolder,
  DownloadInput,
  ItemInput,
  ListFiles,
  ListVersions,
  MoveFile,
  RenameFile,
  RestoreVersion,
} from "#core/features/files/api/schema";
import { FilesDb, ItemRecord, VersionRecord } from "#core/features/files/db";
import {
  accessFor,
  authorizeItem,
  availableName,
  destination,
  projectItem,
  sharesFor,
  validateName,
} from "#core/features/files/policy";
import { fail, now, RequestContext, requireUser, requireValue } from "#core/runtime";

async function subtree(transaction: Transaction, item: ItemRecord): Promise<ItemRecord[]> {
  const children = await transaction.find(
    ItemRecord,
    "item",
    "$root IN ancestorIds AND ownerId = $owner",
    { root: item.key, owner: item.ownerId },
    1001,
  );

  if (children.length > 1000)
    fail("resource.conflict", "This folder exceeds the 1000-item atomic operation limit");

  return children;
}

export class FilesService {
  constructor(private readonly ctx: RequestContext) {}
  list(input: typeof ListFiles.Type) {
    return this.ctx.run(async (transaction, actor) => {
      if (!actor.user && !actor.shareIds.length)
        fail("auth.required", "Sign in or open a shared link");
      const shares = await sharesFor(transaction, actor);

      const folder = input.parentId
        ? (await authorizeItem(transaction, actor, input.parentId, "read")).item
        : null;

      if (folder && folder.kind !== "folder") fail("input.invalid", "This item is not a folder");

      if (input.view === "trash") requireUser(actor);

      const rows = await FilesDb.list(transaction, input, {
        userId: actor.user?.key ?? null,
        rootIds: shares.map((s) => s.itemId),
      });

      const limit = input.limit ?? 100;
      const items = rows.slice(0, limit).map((row) => projectItem(row, actor, shares));

      const ancestors = folder?.ancestorIds.length
        ? await transaction.find(
            ItemRecord,
            "item",
            "key IN $ids AND trashedAt = NULL",
            { ids: folder.ancestorIds },
            64,
          )
        : [];

      const breadcrumbs = (folder?.ancestorIds ?? []).flatMap((id) => {
        const item = ancestors.find((entry) => entry.key === id);

        return item && accessFor(item, actor, shares).canDownload ? [{ id, name: item.name }] : [];
      });

      if (folder) breadcrumbs.push({ id: folder.key, name: folder.name });

      return {
        items,
        breadcrumbs,
        nextCursor: rows.length > limit ? rows[limit - 1]!.key : null,
        folder: folder ? projectItem(folder, actor, shares) : null,
      };
    });
  }
  createFolder(input: typeof CreateFolder.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { owner, parent } = await destination(transaction, actor, input.parentId);
      const name = validateName(input.name);
      await availableName(transaction, owner.key, input.parentId, name);

      const item: ItemRecord = {
        key: newId(),
        name,
        kind: "folder",
        parentId: input.parentId,
        ownerId: owner.key,
        size: 0,
        mimeType: "inode/directory",
        createdAt: now(),
        updatedAt: now(),
        trashedAt: null,
        trashRoot: null,
        ancestorIds: parent ? [...parent.ancestorIds, parent.key] : [],
        objectKey: null,
        uploadedBy: actor.user?.key ?? null,
        revision: 0,
      };

      transaction.put("item", item);

      return projectItem(item, actor, await sharesFor(transaction, actor));
    });
  }
  rename(input: typeof RenameFile.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item, shares } = await authorizeItem(transaction, actor, input.id, "edit");
      const name = validateName(input.name);
      await availableName(transaction, item.ownerId, item.parentId, name, item.key);
      const updated = { ...item, name, updatedAt: now(), revision: item.revision + 1 };
      transaction.put("item", updated);

      return projectItem(updated, actor, shares);
    });
  }
  move(input: typeof MoveFile.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item, shares } = await authorizeItem(transaction, actor, input.id, "owner");
      const { owner, parent } = await destination(transaction, actor, input.parentId);

      if (owner.key !== item.ownerId) fail("access.denied", "Moving cannot transfer ownership");

      if (parent && (parent.key === item.key || parent.ancestorIds.includes(item.key)))
        fail("input.invalid", "A folder cannot be moved inside itself");
      await availableName(transaction, owner.key, input.parentId, item.name, item.key);
      const ancestorIds = parent ? [...parent.ancestorIds, parent.key] : [];
      const children = item.kind === "folder" ? await subtree(transaction, item) : [];

      for (const child of children) {
        const suffix = child.ancestorIds.slice(child.ancestorIds.indexOf(item.key));

        if (ancestorIds.length + suffix.length > 63)
          fail("input.invalid", "Maximum folder depth reached");
        transaction.put("item", {
          ...child,
          ancestorIds: [...ancestorIds, ...suffix],
          revision: child.revision + 1,
        });
      }

      const updated = {
        ...item,
        parentId: input.parentId,
        ancestorIds,
        updatedAt: now(),
        revision: item.revision + 1,
      };

      transaction.put("item", updated);

      return projectItem(updated, actor, shares);
    });
  }
  trash(input: typeof ItemInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item, shares } = await authorizeItem(transaction, actor, input.id, "owner");
      const trashedAt = now();

      for (const child of item.kind === "folder" ? await subtree(transaction, item) : [])
        if (!child.trashedAt)
          transaction.put("item", {
            ...child,
            trashedAt,
            trashRoot: item.key,
            revision: child.revision + 1,
          });

      const updated = {
        ...item,
        trashedAt,
        trashRoot: item.key,
        updatedAt: trashedAt,
        revision: item.revision + 1,
      };

      transaction.put("item", updated);

      return projectItem(updated, actor, shares);
    });
  }
  restore(input: typeof ItemInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item, shares } = await authorizeItem(transaction, actor, input.id, "owner", true);

      if (!item.trashedAt) return projectItem(item, actor, shares);

      if (item.trashRoot !== item.key)
        fail("resource.conflict", "Restore the containing folder first");

      if (item.parentId) await authorizeItem(transaction, actor, item.parentId, "owner");
      await availableName(transaction, item.ownerId, item.parentId, item.name, item.key);

      for (const child of item.kind === "folder" ? await subtree(transaction, item) : [])
        if (child.trashRoot === item.key)
          transaction.put("item", {
            ...child,
            trashedAt: null,
            trashRoot: null,
            revision: child.revision + 1,
          });

      const updated = {
        ...item,
        trashedAt: null,
        trashRoot: null,
        updatedAt: now(),
        revision: item.revision + 1,
      };

      transaction.put("item", updated);

      return projectItem(updated, actor, shares);
    });
  }
  versions(input: typeof ListVersions.Type) {
    return this.ctx.run(async (transaction, actor) => {
      await authorizeItem(transaction, actor, input.id, "owner");

      const rows = await transaction.find(
        VersionRecord,
        "version",
        "fileId = $file AND key > $cursor",
        { file: input.id, cursor: input.cursor ?? "" },
        101,
      );

      return {
        items: rows
          .slice(0, 100)
          .map((v) => ({ id: v.key, fileId: v.fileId, size: v.size, createdAt: v.createdAt })),
        nextCursor: rows.length > 100 ? rows[99]!.key : null,
      };
    });
  }
  restoreVersion(input: typeof RestoreVersion.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item, shares } = await authorizeItem(transaction, actor, input.id, "owner");

      const version = requireValue(
        await transaction.get(VersionRecord, "version", input.versionId),
      );

      if (version.fileId !== item.key || !item.objectKey)
        fail("resource.notFound", "Version not found");

      if (version.objectKey !== item.objectKey)
        transaction.put("version", {
          key: newId(),
          fileId: item.key,
          ownerId: item.ownerId,
          objectKey: item.objectKey,
          size: item.size,
          mimeType: item.mimeType,
          createdAt: now(),
        } satisfies VersionRecord);

      const updated = {
        ...item,
        objectKey: version.objectKey,
        size: version.size,
        mimeType: version.mimeType,
        updatedAt: now(),
        revision: item.revision + 1,
      };

      transaction.put("item", updated);

      return projectItem(updated, actor, shares);
    });
  }
  download(input: typeof DownloadInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const { item } = await authorizeItem(
        transaction,
        actor,
        input.id,
        input.versionId ? "owner" : "read",
      );

      if (item.kind !== "file")
        fail("input.invalid", "Folders cannot be downloaded as a single file");

      const version = input.versionId
        ? await transaction.get(VersionRecord, "version", input.versionId)
        : null;

      if (input.versionId && (!version || version.fileId !== item.key))
        fail("resource.notFound", "Version not found");

      return {
        url: `${this.ctx.config.storagePath}/files/${item.key}${version ? `?version=${version.key}` : ""}`,
        name: item.name,
        size: version?.size ?? item.size,
        mimeType: version?.mimeType ?? item.mimeType,
      };
    });
  }
  async readBinary(id: string, versionId: string | null, range?: string) {
    if (range && !/^bytes=\d*-\d*$/.test(range))
      fail("input.invalid", "Only a single byte range is supported");

    const descriptor = await this.ctx.run(async (transaction, actor) => {
      const { item } = await authorizeItem(transaction, actor, id, versionId ? "owner" : "read");

      if (item.kind !== "file" || !item.objectKey)
        fail("resource.notFound", "File content not found");
      const version = versionId ? await transaction.get(VersionRecord, "version", versionId) : null;

      if (versionId && (!version || version.fileId !== item.key))
        fail("resource.notFound", "Version not found");

      return {
        key: version?.objectKey ?? item.objectKey,
        name: item.name,
        mimeType: version?.mimeType ?? item.mimeType,
      };
    });

    return { ...descriptor, ...(await this.ctx.runtime.storage.read(descriptor.key, range)) };
  }
}

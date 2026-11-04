import { newId } from "@hyori-cloud/lib/crypto";
import { Match } from "@hyori-cloud/lib/effect";
import type { Transaction } from "@hyori-cloud/lib/surreal";
import { UserRecord } from "#core/features/auth/db";
import { ItemRecord, VersionRecord } from "#core/features/files/db";
import {
  accessFor,
  authorizeItem,
  availableName,
  destination,
  projectItem,
  sharesFor,
  validateName,
} from "#core/features/files/policy";
import type { BeginUpload, UploadInput, UploadPartInput } from "#core/features/uploads/api/schema";
import { CHUNK_SIZE, UploadRecord } from "#core/features/uploads/db";
import {
  active,
  type Actor,
  expires,
  fail,
  now,
  RequestContext,
  requireValue,
} from "#core/runtime";

async function initiator(
  transaction: Transaction,
  actor: Actor,
  target: ItemRecord | null,
): Promise<string> {
  if (actor.user) return `user:${actor.user.key}`;

  if (target)
    for (const share of await sharesFor(transaction, actor)) {
      const access = accessFor(target, actor, [share]);

      if (target.kind === "folder" ? access.canUpload : access.canEdit) return `share:${share.key}`;
    }

  return fail("auth.required", "Open a writable shared link");
}

function status(upload: UploadRecord) {
  return {
    uploadId: upload.key,
    chunkSize: CHUNK_SIZE,
    totalParts: Math.max(1, Math.ceil(upload.size / CHUNK_SIZE)),
    parts: upload.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    state: Match.value(upload.state).pipe(
      Match.when("complete", () => "complete" as const),
      Match.when("aborted", () => "aborted" as const),
      Match.whenOr("starting", "uploading", "finalizing", () => "uploading" as const),
      Match.exhaustive,
    ),
    fileId: upload.fileId,
  };
}

async function uploadDestination(
  transaction: Transaction,
  actor: Actor,
  parentId: string | null,
  replaceId: string | null,
) {
  if (!replaceId) return destination(transaction, actor, parentId);
  const { item, owner } = await authorizeItem(transaction, actor, replaceId, "edit");

  if (item.kind !== "file" || item.parentId !== parentId)
    fail("resource.conflict", "Replacement destination changed");

  const parent = parentId
    ? requireValue(await transaction.get(ItemRecord, "item", parentId))
    : null;

  if (parent?.trashedAt) fail("resource.conflict", "Replacement destination was trashed");

  return { owner, parent };
}

async function checked(
  transaction: Transaction,
  actor: Actor,
  id: string,
  allowExpired = false,
): Promise<UploadRecord> {
  const upload = requireValue(
    await transaction.get(UploadRecord, "upload", id),
    "Upload not found",
  );

  const identities = actor.user
    ? [`user:${actor.user.key}`]
    : actor.shareIds.map((id) => `share:${id}`);

  if (!identities.includes(upload.initiator))
    fail("access.denied", "This upload belongs to a different session");

  if (upload.state === "complete") {
    await authorizeItem(transaction, actor, requireValue(upload.fileId), "read");

    return upload;
  }

  if (!allowExpired && !active(upload.expiresAt))
    fail("resource.conflict", "Upload expired; start a new upload");
  const { owner } = await uploadDestination(transaction, actor, upload.parentId, upload.replaceId);

  if (owner.key !== upload.ownerId) fail("access.denied", "Upload destination changed");

  if (upload.replaceId) await authorizeItem(transaction, actor, upload.replaceId, "edit");

  return upload;
}

export class UploadsService {
  constructor(private readonly ctx: RequestContext) {}
  async begin(input: typeof BeginUpload.Type) {
    if (input.size > CHUNK_SIZE * 10000)
      fail("input.invalid", "File exceeds multipart upload limit");

    const upload = await this.ctx.run(async (transaction, actor) => {
      const { owner, parent } = await uploadDestination(
        transaction,
        actor,
        input.parentId,
        input.replaceId ?? null,
      );

      const name = validateName(input.name);

      const replacement = input.replaceId
        ? (await authorizeItem(transaction, actor, input.replaceId, "edit")).item
        : null;

      if (
        replacement &&
        (replacement.kind !== "file" ||
          replacement.ownerId !== owner.key ||
          replacement.parentId !== input.parentId)
      )
        fail("access.denied", "Replacement must belong to this destination");

      if (replacement && replacement.name !== name)
        fail("input.invalid", "Replacement must retain the existing file name");

      if (!replacement) await availableName(transaction, owner.key, input.parentId, name);

      if (owner.usedBytes + owner.reservedBytes + input.size > owner.quotaBytes)
        fail("storage.quotaExceeded", "Not enough storage quota");
      const key = newId();

      const record: UploadRecord = {
        key,
        ownerId: owner.key,
        initiator: await initiator(transaction, actor, replacement ?? parent),
        uploaderId: actor.user?.key ?? null,
        parentId: parent?.key ?? null,
        name,
        size: input.size,
        mimeType: input.mimeType || "application/octet-stream",
        objectKey: `owners/${owner.key}/${key}`,
        multipartId: null,
        replaceId: replacement?.key ?? null,
        replaceRevision: replacement?.revision ?? null,
        state: "starting",
        parts: [],
        createdAt: now(),
        expiresAt: expires(7 * 86400000),
        fileId: null,
        cleanupPending: false,
      };

      transaction.put("user", { ...owner, reservedBytes: owner.reservedBytes + input.size });
      transaction.put("upload", record);

      return record;
    });

    let multipartId: string | null = null;

    try {
      multipartId = await this.ctx.runtime.storage.begin(upload.objectKey, upload.mimeType);
      await this.ctx.runtime.storage.abortUnfinished(upload.objectKey, multipartId);
      const id = multipartId;

      return await this.ctx.run(async (transaction, actor) => {
        const current = await checked(transaction, actor, upload.key);

        if (current.state !== "starting") fail("resource.conflict", "Upload is no longer starting");
        const updated = { ...current, multipartId: id, state: "uploading" as const };
        transaction.put("upload", updated);

        return status(updated);
      });
    } catch (error) {
      await this.cancelReservation(upload.key, multipartId);
      throw error;
    }
  }
  status(input: typeof UploadInput.Type) {
    return this.ctx.run(async (transaction, actor) =>
      status(await checked(transaction, actor, input.uploadId, true)),
    );
  }
  part(input: typeof UploadPartInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const upload = await checked(transaction, actor, input.uploadId);

      if (upload.state !== "uploading" || input.partNumber > status(upload).totalParts)
        fail("resource.conflict", "This upload does not accept that part");

      return {
        url: `${this.ctx.config.storagePath}/uploads/${upload.key}/${input.partNumber}`,
        method: "PUT" as const,
        headers: {},
      };
    });
  }
  async writePart(uploadId: string, partNumber: number, body: Uint8Array) {
    const upload = await this.ctx.run(async (transaction, actor) => {
      const current = await checked(transaction, actor, uploadId);

      if (current.state !== "uploading" || !current.multipartId)
        fail("resource.conflict", "Upload no longer accepts parts");

      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > status(current).totalParts
      )
        fail("input.invalid", "Invalid part number");

      const expected = Math.min(
        CHUNK_SIZE,
        Math.max(0, current.size - (partNumber - 1) * CHUNK_SIZE),
      );

      if (body.byteLength !== expected)
        fail("input.invalid", "Part length does not match the declared file size");

      return current;
    });

    const etag = await this.ctx.runtime.storage.part(
      upload.objectKey,
      upload.multipartId!,
      partNumber,
      body,
    );

    return this.ctx.run(async (transaction, actor) => {
      const current = await checked(transaction, actor, uploadId);

      if (current.state !== "uploading")
        fail("resource.conflict", "Upload no longer accepts parts");

      const parts = [
        ...current.parts.filter((p) => p.partNumber !== partNumber),
        { partNumber, size: body.byteLength, etag },
      ].sort((a, b) => a.partNumber - b.partNumber);

      const updated = { ...current, parts };
      transaction.put("upload", updated);

      return status(updated);
    });
  }
  async complete(input: typeof UploadInput.Type) {
    const upload = await this.ctx.run(async (transaction, actor) => {
      const current = await checked(transaction, actor, input.uploadId);

      if (current.state === "complete") return current;

      if (!["uploading", "finalizing"].includes(current.state) || !current.multipartId)
        fail("resource.conflict", "Upload cannot be completed");

      if (
        current.parts.length !== status(current).totalParts ||
        current.parts.reduce((sum, p) => sum + p.size, 0) !== current.size
      )
        fail("resource.conflict", "Upload is missing parts");
      const owner = requireValue(await transaction.get(UserRecord, "user", current.ownerId));

      if (owner.usedBytes + owner.reservedBytes > owner.quotaBytes)
        fail(
          "storage.quotaExceeded",
          "Storage quota was reduced; free space or request more quota",
        );

      if (current.replaceId) {
        const { item } = await authorizeItem(transaction, actor, current.replaceId, "edit");

        if (item.revision !== current.replaceRevision)
          fail("resource.conflict", "This file changed after the upload began");
      } else await availableName(transaction, current.ownerId, current.parentId, current.name);
      const updated = { ...current, state: "finalizing" as const };
      transaction.put("upload", updated);

      return updated;
    });

    if (upload.state !== "complete")
      await this.ctx.runtime.storage.complete(
        upload.objectKey,
        upload.multipartId!,
        upload.parts,
        upload.size,
      );

    return this.ctx.run(async (transaction, actor) => {
      const current = await checked(transaction, actor, input.uploadId);

      if (current.state === "complete") {
        const { item, shares } = await authorizeItem(
          transaction,
          actor,
          requireValue(current.fileId),
          "read",
        );

        return projectItem(item, actor, shares);
      }

      if (current.state !== "finalizing") fail("resource.conflict", "Upload was cancelled");

      const { owner, parent } = await uploadDestination(
        transaction,
        actor,
        current.parentId,
        current.replaceId,
      );

      if (owner.usedBytes + owner.reservedBytes > owner.quotaBytes)
        fail("storage.quotaExceeded", "Storage quota exceeded");

      const previous = current.replaceId
        ? (await authorizeItem(transaction, actor, current.replaceId, "edit")).item
        : null;

      if (previous && previous.revision !== current.replaceRevision)
        fail("resource.conflict", "This file changed after the upload began");

      if (!previous) await availableName(transaction, owner.key, current.parentId, current.name);

      if (previous?.objectKey)
        transaction.put("version", {
          key: newId(),
          fileId: previous.key,
          ownerId: owner.key,
          objectKey: previous.objectKey,
          size: previous.size,
          mimeType: previous.mimeType,
          createdAt: now(),
        } satisfies VersionRecord);

      const file: ItemRecord = {
        key: previous?.key ?? newId(),
        ownerId: owner.key,
        parentId: current.parentId,
        ancestorIds: parent ? [...parent.ancestorIds, parent.key] : [],
        name: current.name,
        kind: "file",
        size: current.size,
        mimeType: current.mimeType,
        createdAt: previous?.createdAt ?? now(),
        updatedAt: now(),
        trashedAt: null,
        trashRoot: null,
        objectKey: current.objectKey,
        uploadedBy: current.uploaderId,
        revision: (previous?.revision ?? -1) + 1,
      };

      transaction.put("item", file);
      transaction.put("user", {
        ...owner,
        reservedBytes: owner.reservedBytes - current.size,
        usedBytes: owner.usedBytes + current.size,
      });
      transaction.put("upload", {
        ...current,
        state: "complete",
        fileId: file.key,
        cleanupPending: true,
      });

      return projectItem(file, actor, await sharesFor(transaction, actor));
    });
  }
  async abort(input: typeof UploadInput.Type) {
    await this.ctx.run(async (transaction, actor) => {
      const upload = await checked(transaction, actor, input.uploadId, true);

      if (upload.state === "complete")
        fail("resource.conflict", "A committed upload cannot be cancelled");
    });
    await this.cancelReservation(input.uploadId);

    return { success: true as const };
  }
  private async cancelReservation(uploadId: string, multipartId?: string | null): Promise<void> {
    const upload = await this.ctx.run(async (transaction) => {
      const current = requireValue(await transaction.get(UploadRecord, "upload", uploadId));

      if (current.state === "complete")
        fail("resource.conflict", "A committed upload cannot be cancelled");
      const owner = await transaction.get(UserRecord, "user", current.ownerId);

      if (current.state !== "aborted" && owner)
        transaction.put("user", { ...owner, reservedBytes: owner.reservedBytes - current.size });

      const updated = {
        ...current,
        multipartId: current.multipartId ?? multipartId ?? null,
        state: "aborted" as const,
        cleanupPending: true,
      };

      transaction.put("upload", updated);

      return updated;
    });

    if (upload.multipartId)
      await this.ctx.runtime.storage.abort(upload.objectKey, upload.multipartId);
    await this.ctx.runtime.storage.abortUnfinished(upload.objectKey);
    await this.ctx.runtime.storage.remove(upload.objectKey);
    // Retain the cleanup marker: an already-running storage request may finish after cancellation.
  }
}

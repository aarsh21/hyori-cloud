import { digest, newId } from "@hyori-cloud/lib/crypto";
import type { Transaction } from "@hyori-cloud/lib/surreal";
import { ItemRecord } from "#core/features/files/db";
import { authorizeItem, projectItem, sharesFor, validateName } from "#core/features/files/policy";
import type {
  AddToAlbum,
  CreateAlbum,
  PhotoSources,
  TimelineInput,
} from "#core/features/photos/api/schema";
import { AlbumItemRecord, AlbumRecord, SourcesRecord } from "#core/features/photos/db";
import { fail, now, RequestContext, requireUser, requireValue, type Actor } from "#core/runtime";

async function availableSources(
  transaction: Transaction,
  actor: Actor,
  folderIds: readonly string[],
) {
  if (!folderIds.length) return [];
  const shares = await sharesFor(transaction, actor);

  const folders = await transaction.find(
    ItemRecord,
    "item",
    "key IN $ids AND kind = 'folder' AND trashedAt = NULL AND ownerId IN (SELECT VALUE key FROM hc_user WHERE status = 'active') AND (ownerId = $user OR key IN $roots OR array::intersect(ancestorIds, $roots) != [])",
    { ids: folderIds, user: requireUser(actor).key, roots: shares.map((share) => share.itemId) },
    100,
  );

  const available = new Set(folders.map((folder) => folder.key));

  return [...new Set(folderIds)].filter((id) => available.has(id));
}

const MEDIA = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
];

type TimelineVariables = {
  user: SourcesRecord["key"];
  roots: ItemRecord["key"][];
  media: typeof MEDIA;
  album?: typeof TimelineInput.Type.albumId;
  all?: SourcesRecord["allMyFiles"];
  folders?: SourcesRecord["folderIds"];
  date?: ItemRecord["createdAt"];
  key?: ItemRecord["key"];
};

export class PhotosService {
  constructor(private readonly ctx: RequestContext) {}
  sources() {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);
      const saved = await transaction.get(SourcesRecord, "sources", user.key);

      return {
        allMyFiles: saved?.allMyFiles ?? false,
        folderIds: await availableSources(transaction, actor, saved?.folderIds ?? []),
      };
    });
  }
  setSources(input: typeof PhotoSources.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);

      const sources = {
        allMyFiles: input.allMyFiles,
        folderIds: await availableSources(transaction, actor, input.folderIds),
      };

      transaction.put("sources", { key: user.key, ...sources });

      return sources;
    });
  }
  timeline(input: typeof TimelineInput.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);
      const shares = await sharesFor(transaction, actor);
      const sources = await transaction.get(SourcesRecord, "sources", user.key);

      const conditions = [
        "trashedAt = NULL",
        "mimeType IN $media",
        "ownerId IN (SELECT VALUE key FROM hc_user WHERE status = 'active')",
        "(ownerId = $user OR key IN $roots OR array::intersect(ancestorIds, $roots) != [])",
      ];

      const variables: TimelineVariables = {
        user: user.key,
        roots: shares.map((share) => share.itemId),
        media: MEDIA,
      };

      if (input.albumId) {
        const album = requireValue(await transaction.get(AlbumRecord, "album", input.albumId));

        if (album.ownerId !== user.key) fail("access.denied", "Album not found");
        conditions.push(
          "key IN (SELECT VALUE fileId FROM hc_album_item WHERE albumId = $album AND ownerId = $user)",
        );
        variables.album = input.albumId;
      } else {
        conditions.push(
          "(($all = true AND ownerId = $user) OR array::intersect(ancestorIds, $folders) != [])",
        );
        variables.all = sources?.allMyFiles ?? false;
        variables.folders = sources?.folderIds ?? [];
      }

      if (input.cursor) {
        const [createdAt, key] = input.cursor.split("|");

        if (!createdAt || !key || !Number.isFinite(Date.parse(createdAt)))
          fail("input.invalid", "Invalid timeline cursor");
        conditions.push("(createdAt < $date OR (createdAt = $date AND key < $key))");
        variables.date = createdAt;
        variables.key = key;
      }

      const rows = await transaction.find(
        ItemRecord,
        "item",
        conditions.join(" AND "),
        variables,
        101,
        "createdAt DESC, key DESC",
      );

      const last = rows[99];

      return {
        items: rows.slice(0, 100).map((item) => ({
          ...projectItem(item, actor, shares),
          previewUrl: `${this.ctx.config.storagePath}/files/${item.key}`,
        })),
        nextCursor: rows.length > 100 && last ? `${last.createdAt}|${last.key}` : null,
        breadcrumbs: [],
        folder: null,
      };
    });
  }
  albums() {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);

      const albums = await transaction.find(
        AlbumRecord,
        "album",
        "ownerId = $user",
        { user: user.key },
        100,
      );

      return {
        items: albums.map((album) => ({
          id: album.key,
          name: album.name,
          createdAt: album.createdAt,
          count: album.count,
        })),
      };
    });
  }
  createAlbum(input: typeof CreateAlbum.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);

      if (
        (await transaction.find(AlbumRecord, "album", "ownerId = $user", { user: user.key }, 100))
          .length >= 100
      )
        fail("resource.conflict", "Album limit reached");

      const album: AlbumRecord = {
        key: newId(),
        ownerId: user.key,
        name: validateName(input.name),
        createdAt: now(),
        count: 0,
      };

      transaction.put("album", album);

      return { id: album.key, name: album.name, createdAt: album.createdAt, count: 0 };
    });
  }
  addToAlbum(input: typeof AddToAlbum.Type) {
    return this.ctx.run(async (transaction, actor) => {
      const user = requireUser(actor);
      const album = requireValue(await transaction.get(AlbumRecord, "album", input.albumId));

      if (album.ownerId !== user.key) fail("access.denied", "Album not found");
      let count = album.count;

      for (const id of new Set(input.fileIds)) {
        const { item } = await authorizeItem(transaction, actor, id, "read");

        if (!MEDIA.includes(item.mimeType))
          fail("input.invalid", "Only supported photos and videos can be added");
        const key = digest(`${album.key}:${id}`);

        if (await transaction.get(AlbumItemRecord, "album_item", key)) continue;
        transaction.put("album_item", { key, albumId: album.key, fileId: id, ownerId: user.key });
        count++;
      }

      if (count > 1000) fail("resource.conflict", "Album item limit reached");
      transaction.put("album", { ...album, count });

      return { success: true as const };
    });
  }
}

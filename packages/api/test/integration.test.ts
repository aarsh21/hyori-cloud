import { describe, expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { newId } from "@hyori-cloud/lib/crypto";
import { createHandler, type Handler, type ServerConfig } from "@hyori-cloud/api";
import { operations, ApiError } from "@hyori-cloud/api/rpc";

type Operation = (typeof operations)[number];

type Tag = Operation["rpc"]["_tag"];

type Input<T extends Tag> = Schema.Schema.Type<
  Extract<Operation, { rpc: { _tag: T } }>["rpc"]["payloadSchema"]
>;

type Output<T extends Tag> = Schema.Schema.Type<
  Extract<Operation, { rpc: { _tag: T } }>["rpc"]["successSchema"]
>;

const origin = "http://localhost:4199";
const setupToken = "test-only-setup-token-never-for-production";
const password = "memorable test passphrase 123";

function configuration(): ServerConfig {
  return {
    origin,
    setupToken,
    secureCookies: false,
    defaultQuotaBytes: 32 * 1024 * 1024,
    surreal: {
      url: process.env.HYORI_TEST_SURREAL_URL ?? "http://127.0.0.1:18000",
      namespace: "hyori_test",
      database: `test_${newId()}`,
      username: process.env.HYORI_TEST_SURREAL_USER ?? "root",
      password: process.env.HYORI_TEST_SURREAL_PASSWORD ?? "root",
    },
    storage: {
      endpoint: process.env.HYORI_TEST_STORAGE_ENDPOINT ?? "http://127.0.0.1:19000",
      region: "us-east-1",
      bucket: `hyori-test-${newId()}`,
      accessKeyId: process.env.HYORI_TEST_STORAGE_ACCESS_KEY ?? "test-access-key",
      secretAccessKey: process.env.HYORI_TEST_STORAGE_SECRET_KEY ?? "test-secret-key",
    },
  };
}

class Consumer {
  readonly cookies = new Map<string, string>();
  lastCookies: string[] = [];
  constructor(readonly handler: Handler) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Origin", origin);

    if (this.cookies.size)
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    const response = await this.handler(new Request(new URL(path, origin), { ...init, headers }));
    this.lastCookies = response.headers.getSetCookie();

    for (const cookie of this.lastCookies) {
      const [pair] = cookie.split(";");
      const position = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, position), pair!.slice(position + 1));
    }

    return response;
  }
  async raw<T extends Tag>(operation: T, input: Input<T>) {
    const response = await this.request("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, input }),
    });

    const declaration = operations.find(({ rpc }) => rpc._tag === operation);

    if (!declaration) throw new Error(`Unknown test operation: ${operation}`);

    const envelope = Schema.Union(
      Schema.Struct({ ok: Schema.Literal(true), value: declaration.rpc.successSchema }),
      Schema.Struct({ ok: Schema.Literal(false), error: ApiError }),
    );

    return Schema.decodeUnknownSync(envelope)(await response.json());
  }
  async rpc<T extends Tag>(operation: T, input: Input<T>): Promise<Output<T>> {
    const result = await this.raw(operation, input);

    if (!result.ok) throw new Error(`${operation}: ${result.error.code}: ${result.error.message}`);

    // SAFETY: raw selected the declaration by this exact tag and decoded the success value
    // with its schema; this restores the generic tag/result relation lost by Array.find.
    return result.value as Output<T>;
  }
  async denied<T extends Tag>(operation: T, input: Input<T>, code: ApiError["code"]) {
    const result = await this.raw(operation, input);
    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error.code).toBe(code);
  }
  async upload(
    parentId: string | null,
    name: string,
    data: Uint8Array,
    mimeType = "text/plain",
    replaceId?: string,
  ) {
    const upload = await this.rpc("uploads.begin", {
      parentId,
      name,
      size: data.byteLength,
      mimeType,
      replaceId,
    });

    for (let partNumber = 1; partNumber <= upload.totalParts; partNumber++) {
      const capability = await this.rpc("uploads.part", { uploadId: upload.uploadId, partNumber });

      const response = await this.request(capability.url, {
        method: "PUT",
        body: data.slice((partNumber - 1) * upload.chunkSize, partNumber * upload.chunkSize),
      });

      expect(response.status).toBe(200);
    }

    return { file: await this.rpc("uploads.complete", { uploadId: upload.uploadId }), upload };
  }
}

describe("Fetch boundary before persistence", () => {
  test("invalid input and cross-origin requests fail closed", async () => {
    const handler = createHandler(configuration());
    const consumer = new Consumer(handler);
    await consumer.denied("files.createFolder", { name: "", parentId: null }, "input.invalid");

    const response = await handler(
      new Request(`${origin}/api/rpc`, {
        method: "POST",
        headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    handler.dispose();
  });
  test("unavailable persistence is not reported as uninitialized", async () => {
    const config = configuration();

    const handler = createHandler({
      ...config,
      surreal: { ...config.surreal, url: "http://127.0.0.1:1" },
    });

    await new Consumer(handler).denied("auth.status", {}, "service.unavailable");
    handler.dispose();
  });
});

const enabled = Boolean(
  process.env.HYORI_TEST_SURREAL_URL && process.env.HYORI_TEST_STORAGE_ENDPOINT,
);

(enabled ? describe : describe.skip)("real SurrealDB + RustFS security and lifecycle", () => {
  test("bootstrap race, isolation, binary resume, recovery, recursive sharing, quotas, photos and account purge", async () => {
    const config = configuration();

    const handler = createHandler({
      ...config,
      onError: (error) => console.error("Integration backend failure:", error),
    });

    const secondHandler = createHandler({
      ...config,
      onError: (error) => console.error("Integration second backend failure:", error),
    });

    try {
      const adminA = new Consumer(handler);
      const adminB = new Consumer(secondHandler);
      expect((await adminA.rpc("auth.status", {})).initialized).toBe(false);
      await adminB.rpc("auth.status", {});
      await adminA.denied(
        "auth.setup",
        { setupToken: "wrong", email: "intruder@example.test", name: "Intruder", password },
        "auth.setupDenied",
      );

      const race = await Promise.all([
        adminA.raw("auth.setup", {
          setupToken,
          email: "admin-a@example.test",
          name: "Admin A",
          password,
        }),
        adminB.raw("auth.setup", {
          setupToken,
          email: "admin-b@example.test",
          name: "Admin B",
          password,
        }),
      ]);

      expect(race.filter((result) => result.ok)).toHaveLength(1);
      const admin = race[0]!.ok ? adminA : adminB;
      expect(admin.lastCookies.join(";")).toContain("HttpOnly");
      expect(admin.lastCookies.join(";")).toContain("SameSite=Strict");
      await admin.denied(
        "auth.setup",
        { setupToken, email: "third@example.test", name: "Third", password },
        "auth.setupDenied",
      );

      const ownerUser = await admin.rpc("admin.createUser", {
        email: "owner@example.test",
        name: "Owner",
        password,
      });

      const editorUser = await admin.rpc("admin.createUser", {
        email: "editor@example.test",
        name: "Editor",
        password,
      });

      const owner = new Consumer(handler);
      const editor = new Consumer(handler);
      const anonymous = new Consumer(handler);
      await owner.rpc("auth.login", { email: ownerUser.email, password });
      await editor.rpc("auth.login", { email: editorUser.email, password });
      await anonymous.denied("files.list", {}, "auth.required");
      const folder = await owner.rpc("files.createFolder", { parentId: null, name: "Pictures" });
      const nested = await owner.rpc("files.createFolder", { parentId: folder.id, name: "Nested" });
      await owner.denied(
        "files.createFolder",
        { parentId: nested.id, name: "̈́".repeat(128) },
        "input.invalid",
      );
      expect((await owner.rpc("files.list", { parentId: nested.id })).items).toEqual([]);
      const empty = await owner.upload(null, "empty.txt", new Uint8Array());
      const emptyDownload = await owner.rpc("files.download", { id: empty.file.id });
      expect((await (await owner.request(emptyDownload.url)).arrayBuffer()).byteLength).toBe(0);
      await owner.denied("files.rename", { id: empty.file.id, name: "\uD800" }, "input.invalid");
      await owner.denied("files.rename", { id: empty.file.id, name: "\uDC00" }, "input.invalid");
      await owner.rpc("files.rename", { id: empty.file.id, name: "📷.txt" });
      const unicodeDownload = await owner.request(emptyDownload.url);
      expect(unicodeDownload.status).toBe(200);
      expect(unicodeDownload.headers.get("Content-Disposition")).toContain("%F0%9F%93%B7");
      expect((await unicodeDownload.arrayBuffer()).byteLength).toBe(0);
      await owner.rpc("files.rename", { id: empty.file.id, name: "empty.txt" });

      const cancelled = await owner.rpc("uploads.begin", {
        parentId: null,
        name: "cancelled.txt",
        size: 2,
        mimeType: "text/plain",
      });

      await owner.rpc("uploads.abort", { uploadId: cancelled.uploadId });
      expect((await owner.rpc("uploads.status", { uploadId: cancelled.uploadId })).state).toBe(
        "aborted",
      );
      await owner.denied("uploads.complete", { uploadId: cancelled.uploadId }, "resource.conflict");
      expect((await owner.rpc("files.list", { search: "cancelled" })).items).toHaveLength(0);
      await admin.denied("files.list", { parentId: folder.id }, "access.denied");
      await editor.denied("files.rename", { id: folder.id, name: "stolen" }, "access.denied");

      const initial = await owner.upload(
        nested.id,
        "original.txt",
        new TextEncoder().encode("first version"),
      );

      const capability = await owner.rpc("files.download", { id: initial.file.id });
      expect(await (await owner.request(capability.url)).text()).toBe("first version");
      expect((await anonymous.request(capability.url)).status).toBe(403);
      const large = new Uint8Array(8 * 1024 * 1024 + 13).fill(37);

      const pending = await owner.rpc("uploads.begin", {
        parentId: nested.id,
        name: "original.txt",
        size: large.byteLength,
        mimeType: "text/plain",
        replaceId: initial.file.id,
      });

      const part = await owner.rpc("uploads.part", { uploadId: pending.uploadId, partNumber: 1 });
      expect(
        (await owner.request(part.url, { method: "PUT", body: large.slice(0, pending.chunkSize) }))
          .status,
      ).toBe(200);
      const resumed = await owner.rpc("uploads.status", { uploadId: pending.uploadId });
      expect(resumed.parts).toEqual([{ partNumber: 1, size: pending.chunkSize }]);
      await owner.denied("uploads.complete", { uploadId: pending.uploadId }, "resource.conflict");
      expect(await (await owner.request(capability.url)).text()).toBe("first version");
      const second = await owner.rpc("uploads.part", { uploadId: pending.uploadId, partNumber: 2 });
      expect(
        (await owner.request(second.url, { method: "PUT", body: large.slice(pending.chunkSize) }))
          .status,
      ).toBe(200);
      const replacement = await owner.rpc("uploads.complete", { uploadId: pending.uploadId });
      expect((await owner.rpc("uploads.complete", { uploadId: pending.uploadId })).id).toBe(
        replacement.id,
      );
      expect(new Uint8Array(await (await owner.request(capability.url)).arrayBuffer())).toEqual(
        large,
      );
      const versions = await owner.rpc("files.versions", { id: replacement.id });
      expect(versions.items).toHaveLength(1);
      await owner.rpc("files.restoreVersion", {
        id: replacement.id,
        versionId: versions.items[0]!.id,
      });
      expect(await (await owner.request(capability.url)).text()).toBe("first version");

      const directEditor = await owner.rpc("shares.create", {
        itemId: replacement.id,
        recipientId: editorUser.id,
        public: false,
        role: "editor",
      });

      await editor.denied("files.list", { parentId: nested.id }, "access.denied");
      await editor.upload(
        nested.id,
        replacement.name,
        new TextEncoder().encode("direct editor version"),
        "text/plain",
        replacement.id,
      );
      expect(await (await owner.request(capability.url)).text()).toBe("direct editor version");
      await owner.rpc("shares.revoke", { id: directEditor.id });

      const shared = await owner.rpc("shares.create", {
        itemId: folder.id,
        recipientId: editorUser.id,
        public: false,
        role: "contributor",
      });

      await owner.denied(
        "shares.create",
        { itemId: folder.id, recipientId: editorUser.id, public: false, role: "viewer" },
        "resource.conflict",
      );
      expect((await editor.rpc("files.list", { parentId: nested.id })).items).toHaveLength(1);
      await editor.denied(
        "uploads.begin",
        {
          parentId: nested.id,
          name: replacement.name,
          size: 5,
          mimeType: "text/plain",
          replaceId: replacement.id,
        },
        "access.denied",
      );

      const contributed = await editor.upload(
        nested.id,
        "contributed.txt",
        new Uint8Array([1, 2, 3]),
      );

      expect(contributed.file.ownerId).toBe(ownerUser.id);
      await editor.denied("files.trash", { id: contributed.file.id }, "access.denied");
      await owner.rpc("shares.revoke", { id: shared.id });
      await editor.denied("files.download", { id: contributed.file.id }, "access.denied");
      await owner.rpc("shares.create", {
        itemId: folder.id,
        recipientId: editorUser.id,
        public: false,
        role: "editor",
      });
      await editor.rpc("files.rename", { id: contributed.file.id, name: "renamed.txt" });
      await editor.denied("files.trash", { id: contributed.file.id }, "access.denied");
      await editor.denied(
        "shares.create",
        { itemId: contributed.file.id, role: "viewer", public: true },
        "access.denied",
      );

      const expiring = await owner.rpc("shares.create", {
        itemId: folder.id,
        role: "viewer",
        public: true,
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      });

      await anonymous.rpc("shares.resolve", { token: expiring.url!.split("/").at(-1)! });
      const beforeExpiry = await anonymous.request(capability.url);
      expect(beforeExpiry.status).toBe(200);
      await beforeExpiry.arrayBuffer();
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await anonymous.denied("files.download", { id: replacement.id }, "access.denied");

      const publicShare = await owner.rpc("shares.create", {
        itemId: folder.id,
        role: "contributor",
        public: true,
        password: "shared-secret-passphrase",
      });

      const token = publicShare.url!.split("/").at(-1)!;
      expect((await anonymous.rpc("shares.resolve", { token })).requiresPassword).toBe(true);
      await anonymous.denied("shares.unlock", { token, password: "wrong" }, "access.denied");
      await anonymous.rpc("shares.unlock", { token, password: "shared-secret-passphrase" });

      const anonymousPending = await anonymous.rpc("uploads.begin", {
        parentId: nested.id,
        name: "anonymous.txt",
        size: 1,
        mimeType: "text/plain",
      });

      const secondPublicShare = await owner.rpc("shares.create", {
        itemId: empty.file.id,
        role: "viewer",
        public: true,
      });

      await anonymous.rpc("shares.resolve", { token: secondPublicShare.url!.split("/").at(-1)! });
      expect(anonymous.cookies.has(`hyori_share_${publicShare.id}`)).toBe(true);
      expect(anonymous.cookies.has(`hyori_share_${secondPublicShare.id}`)).toBe(true);
      expect(
        (await anonymous.rpc("files.list", { parentId: nested.id })).items.length,
      ).toBeGreaterThan(0);

      const stillAuthorized = await anonymous.rpc("uploads.part", {
        uploadId: anonymousPending.uploadId,
        partNumber: 1,
      });

      expect(
        (await anonymous.request(stillAuthorized.url, { method: "PUT", body: new Uint8Array([7]) }))
          .status,
      ).toBe(200);
      await owner.rpc("shares.revoke", { id: publicShare.id });
      await anonymous.denied(
        "uploads.part",
        { uploadId: anonymousPending.uploadId, partNumber: 1 },
        "access.denied",
      );
      await anonymous.denied("files.download", { id: replacement.id }, "access.denied");
      expect((await anonymous.request(emptyDownload.url)).status).toBe(200);
      await admin.rpc("admin.setQuota", { userId: ownerUser.id, quotaBytes: 1 });
      await owner.denied(
        "uploads.begin",
        { parentId: nested.id, name: "quota.txt", size: 1, mimeType: "text/plain" },
        "storage.quotaExceeded",
      );
      await admin.rpc("admin.setQuota", { userId: ownerUser.id, quotaBytes: 32 * 1024 * 1024 });

      const photo = await owner.upload(
        nested.id,
        "image.png",
        new Uint8Array([137, 80, 78, 71]),
        "image/png",
      );

      await owner.rpc("photos.setSources", { allMyFiles: false, folderIds: [folder.id] });
      expect((await owner.rpc("photos.timeline", {})).items.map((entry) => entry.id)).toContain(
        photo.file.id,
      );
      expect((await owner.rpc("photos.timeline", {})).items[0]?.previewUrl).toBe(
        `/api/storage/files/${photo.file.id}`,
      );
      const album = await owner.rpc("photos.createAlbum", { name: "Holiday" });
      await owner.rpc("photos.addToAlbum", { albumId: album.id, fileIds: [photo.file.id] });
      expect((await owner.rpc("photos.timeline", { albumId: album.id })).items).toHaveLength(1);
      await owner.rpc("files.trash", { id: folder.id });
      expect((await owner.rpc("photos.timeline", {})).items).toHaveLength(0);
      expect((await owner.rpc("photos.sources", {})).folderIds).toEqual([]);
      expect(
        await owner.rpc("photos.setSources", { allMyFiles: true, folderIds: [folder.id] }),
      ).toEqual({ allMyFiles: true, folderIds: [] });
      await editor.denied("files.download", { id: replacement.id }, "resource.notFound");
      await owner.rpc("files.restore", { id: folder.id });
      expect((await owner.rpc("files.list", { parentId: nested.id })).items.length).toBe(3);
      await owner.rpc("files.move", { id: nested.id, parentId: null });
      await editor.denied("files.download", { id: replacement.id }, "access.denied");
      expect((await editor.rpc("files.list", { search: "original" })).items).toHaveLength(0);

      const editorFolder = await editor.rpc("files.createFolder", {
        parentId: null,
        name: "Editor-owned",
      });

      await editor.rpc("shares.create", {
        itemId: editorFolder.id,
        recipientId: ownerUser.id,
        public: false,
        role: "contributor",
      });

      const survives = await owner.upload(
        editorFolder.id,
        "keep.txt",
        new TextEncoder().encode("keep this"),
      );

      await admin.denied(
        "admin.deleteUser",
        { userId: ownerUser.id, confirmEmail: "incorrect" },
        "input.invalid",
      );

      const collision = await admin.rpc("admin.createUser", {
        email: `deleted-${ownerUser.id}@invalid.local`,
        name: "Existing account",
        password,
      });

      const deletion = await admin.rpc("admin.deleteUser", {
        userId: ownerUser.id,
        confirmEmail: ownerUser.email,
      });

      expect(deletion.state).toBe("complete");
      expect((await owner.rpc("auth.status", {})).user).toBeNull();
      await editor.denied("files.download", { id: replacement.id }, "resource.notFound");
      const kept = await editor.rpc("files.download", { id: survives.file.id });
      expect(await (await editor.request(kept.url)).text()).toBe("keep this");
      expect(
        (await admin.rpc("admin.users", {})).items.some((user) => user.id === ownerUser.id),
      ).toBe(false);
      expect(
        (await admin.rpc("admin.users", {})).items.some((user) => user.id === collision.id),
      ).toBe(true);
      await handler.maintenance();
      expect(
        (await admin.rpc("admin.users", {})).items.some((user) => user.id === ownerUser.id),
      ).toBe(false);
      await editor.rpc("auth.logout", {});
      expect((await editor.rpc("auth.status", {})).user).toBeNull();
    } finally {
      handler.dispose();
      secondHandler.dispose();
    }
  }, 120000);
});

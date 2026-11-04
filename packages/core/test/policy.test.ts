import { describe, expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { accessFor, validateName } from "#core/features/files/policy";
import type { ItemRecord } from "#core/features/files/db";
import type { ShareRecord } from "#core/features/shares/db";
import type { Actor } from "#core/runtime";
import { operations } from "#core/rpc";
import { hashPassword, verifyPassword } from "@hyori-cloud/lib/crypto";

const item: ItemRecord = {
  key: "child",
  name: "private.txt",
  kind: "file",
  parentId: "folder",
  ownerId: "owner",
  size: 5,
  mimeType: "text/plain",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  trashedAt: null,
  trashRoot: null,
  ancestorIds: ["folder"],
  objectKey: "private/key",
  uploadedBy: "contributor",
  revision: 0,
};

const actor: Actor = {
  user: {
    key: "contributor",
    email: "test@example.test",
    name: "Test",
    role: "admin",
    quotaBytes: 100,
    usedBytes: 0,
    reservedBytes: 0,
    passwordHash: "",
    status: "active",
  },
  shareIds: [],
  sessionHash: null,
  grantHashes: [],
};

function share(role: ShareRecord["role"]): ShareRecord {
  return {
    key: "share",
    itemId: "folder",
    issuerId: "owner",
    role,
    recipientId: "contributor",
    public: false,
    expiresAt: null,
    revokedAt: null,
    tokenHash: null,
    passwordHash: null,
    createdAt: item.createdAt,
  };
}

describe("recursive three-role policy", () => {
  test("administrator and upload attribution do not grant ownership or read access", () => {
    expect(accessFor(item, actor, [])).toMatchObject({
      isOwner: false,
      canDelete: false,
      canDownload: false,
    });
  });
  test.each(["viewer", "contributor", "editor"] as const)(
    "%s never grants deletion or resharing",
    (role) => {
      expect(accessFor(item, actor, [share(role)])).toMatchObject({
        canDownload: true,
        canDelete: false,
        canShare: false,
        canEdit: role === "editor",
      });
    },
  );
  test("contributor can upload into a shared folder but not overwrite", () => {
    expect(accessFor({ ...item, kind: "folder" }, actor, [share("contributor")])).toMatchObject({
      canUpload: true,
      canEdit: false,
    });
  });
  test("expired, revoked, and trashed access is denied", () => {
    expect(
      accessFor(item, actor, [{ ...share("editor"), expiresAt: "2020-01-01T00:00:00Z" }])
        .canDownload,
    ).toBe(false);
    expect(
      accessFor(item, actor, [{ ...share("editor"), revokedAt: "2026-01-01T00:00:00Z" }])
        .canDownload,
    ).toBe(false);
    expect(
      accessFor({ ...item, trashedAt: item.createdAt }, actor, [share("editor")]).canDownload,
    ).toBe(false);
  });
  test("strongest active direct or inherited role wins without making an owner", () => {
    expect(
      accessFor(item, actor, [share("editor"), { ...share("viewer"), itemId: item.key }]),
    ).toMatchObject({ role: "editor", isOwner: false, canDelete: false });
  });
  test("path and control characters are rejected", () => {
    for (const name of ["..", "/", "a\\b", "\u0000", "  "])
      expect(() => validateName(name)).toThrow();
    expect(validateName(" Photos ")).toBe("Photos");
  });
});

test("authoritative operation declarations have unique tags and runtime input codecs", () => {
  expect(new Set(operations.map(({ rpc }) => rpc._tag)).size).toBe(operations.length);

  for (const { rpc } of operations)
    expect(() => Schema.decodeUnknownSync(Schema.asSchema(rpc.payloadSchema))(null)).toThrow();
});

test("password storage is salted and verifies without plaintext recovery", async () => {
  const hash = await hashPassword("a memorable test passphrase");
  expect(hash).not.toContain("memorable");
  expect(await verifyPassword("a memorable test passphrase", hash)).toBe(true);
  expect(await verifyPassword("wrong password", hash)).toBe(false);
  expect(await hashPassword("a memorable test passphrase")).not.toBe(hash);
});

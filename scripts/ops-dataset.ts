// Seed a deployment with a known dataset through the public SDK, or verify one against its manifest.
//
//   bun scripts/ops-dataset.ts seed   --origin https://cloud.example --ca root.crt --manifest m.json \
//       --setup-token "$HYORI_SETUP_TOKEN" [--data-dir /tmp/hyori-ops-data] [--large-mib 120]
//   bun scripts/ops-dataset.ts verify --origin https://cloud.example --ca root.crt --manifest m.json
//
// The manifest holds fixture passwords and the SHA-256 of every file and version. Keep it private.
// Verification reads everything back through the gateway: every file's bytes, every version's bytes,
// shares (including an anonymous public-link resolve), the member account and the photo album.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  diskFile,
  hashStream,
  login,
  options,
  readManifest,
  type FileRecord,
  type Manifest,
  sha256File,
  writeRandomFile,
  type Session,
} from "./ops-client.ts";

const args = options();
const command = args.positional[0];
const manifestPath = args.get("manifest");
const gateway = args.gateway();

const signIn = (email: string, password: string) => login(gateway, email, password);

async function upload(session: Session, parentId: string | null, path: string, name: string) {
  const type = name.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";

  return session.sdk.uploads.start({ parentId, file: diskFile(path, name, type) }).result;
}

async function download(session: Session, id: string, versionId?: string) {
  const opened = await session.sdk.downloads.open(versionId ? { id, versionId } : { id });

  return hashStream(opened.stream);
}

async function seed() {
  const dataDir = args.get("data-dir", "/tmp/hyori-ops-data");
  const largeMiB = Number(args.get("large-mib", "120"));
  mkdirSync(dataDir, { recursive: true });
  const owner = connect(gateway);
  const ownerPassword = randomBytes(18).toString("base64url");

  const ownerUser = await owner.sdk.rpc.auth.setup({
    setupToken: args.get("setup-token"),
    email: "owner@hyori.test",
    name: "Owner",
    password: ownerPassword,
  });

  const memberPassword = randomBytes(18).toString("base64url");

  const memberUser = await owner.sdk.rpc.admin.createUser({
    email: "member@hyori.test",
    name: "Member",
    password: memberPassword,
    quotaBytes: 2 * 1024 * 1024 * 1024,
  });

  const folders: Record<string, string> = {};

  for (const [path, parent] of [
    ["Documents", null],
    ["Photos", null],
    ["Archive", null],
    ["Archive/2026", "Archive"],
  ] as const) {
    const folder = await owner.sdk.rpc.files.createFolder({
      parentId: parent ? folders[parent]! : null,
      name: path.split("/").at(-1)!,
    });

    folders[path] = folder.id;
  }

  const files: FileRecord[] = [];

  const sizes = [
    0,
    1,
    1023,
    64 * 1024,
    1024 * 1024,
    8 * 1024 * 1024 - 1,
    8 * 1024 * 1024 + 1,
    20 * 1024 * 1024,
    largeMiB * 1024 * 1024,
  ];

  for (const [index, size] of sizes.entries()) {
    const folder = index % 2 ? "Documents" : "Archive/2026";
    const name = `file-${index}-${size}.bin`;
    const path = join(dataDir, name);
    const sha256 = await writeRandomFile(path, size);
    const entry = await upload(owner, folders[folder]!, path, name);
    files.push({ id: entry.id, path: `${folder}/${name}`, size, sha256, versions: [] });
  }

  for (let index = 0; index < 4; index++) {
    const name = `photo-${index}.jpg`;
    const path = join(dataDir, name);
    // Synthetic noise photograph, large enough to exercise the thumbnail decoder.
    execFileSync("magick", ["-size", "2400x1600", `plasma:fractal`, "-quality", "88", path]);
    const entry = await upload(owner, folders.Photos!, path, name);
    files.push({
      id: entry.id,
      path: `Photos/${name}`,
      size: Bun.file(path).size,
      sha256: await sha256File(path),
      versions: [],
    });
  }

  // Two files get two replacements each, so each keeps two prior versions.
  for (const record of files.filter(
    (file) => file.size === 1024 * 1024 || file.size === 20 * 1024 * 1024,
  )) {
    for (let round = 0; round < 2; round++) {
      const path = join(dataDir, `replacement-${record.id}-${round}.bin`);
      const sha256 = await writeRandomFile(path, record.size + round + 1);
      const name = record.path.split("/").at(-1)!;
      await owner.sdk.uploads.replace({
        parentId: folders[record.path.slice(0, record.path.lastIndexOf("/"))]!,
        file: diskFile(path, name),
        target: { id: record.id, name },
      }).result;
      record.size = Bun.file(path).size;
      record.sha256 = sha256;
    }

    const versions = await owner.sdk.rpc.files.versions({ id: record.id });
    assert.equal(versions.items.length, 2);

    for (const version of versions.items) {
      const read = await download(owner, record.id, version.id);
      record.versions.push({ id: version.id, size: version.size, sha256: read.sha256 });
    }
  }

  const trashed = files.find((file) => file.size === 1023)!;
  await owner.sdk.rpc.files.trash({ id: trashed.id });
  trashed.trashed = true;
  const shares: Manifest["shares"] = [];

  const publicShare = await owner.sdk.rpc.shares.create({
    itemId: folders.Documents!,
    public: true,
    role: "viewer",
  });

  shares.push({ ...publicShare, role: publicShare.role });
  const sharePassword = randomBytes(9).toString("base64url");

  const lockedShare = await owner.sdk.rpc.shares.create({
    itemId: files[7]!.id,
    public: true,
    role: "viewer",
    password: sharePassword,
  });

  shares.push({ ...lockedShare, password: sharePassword });

  const memberShare = await owner.sdk.rpc.shares.create({
    itemId: folders.Photos!,
    public: false,
    role: "editor",
    recipientId: memberUser.id,
  });

  shares.push({ ...memberShare });
  const album = await owner.sdk.rpc.photos.createAlbum({ name: "Holiday" });
  const photoIds = files.flatMap((file) => (file.path.startsWith("Photos/") ? [file.id] : []));
  await owner.sdk.rpc.photos.addToAlbum({ albumId: album.id, fileIds: photoIds.slice(0, 3) });
  const member = await signIn("member@hyori.test", memberPassword);
  const memberPath = join(dataDir, "member-notes.bin");
  const memberSha = await writeRandomFile(memberPath, 3 * 1024 * 1024 + 7);
  const memberEntry = await upload(member, null, memberPath, "member-notes.bin");

  const manifest: Manifest = {
    createdAt: new Date().toISOString(),
    owner: { email: "owner@hyori.test", password: ownerPassword, id: ownerUser.id },
    member: { email: "member@hyori.test", password: memberPassword, id: memberUser.id },
    folders,
    files,
    memberFiles: [
      {
        id: memberEntry.id,
        path: "member-notes.bin",
        size: 3 * 1024 * 1024 + 7,
        sha256: memberSha,
        versions: [],
      },
    ],
    shares: shares.map((share) => ({
      id: share.id,
      itemId: share.itemId,
      role: share.role,
      public: share.public,
      recipientId: share.recipientId,
      url: share.url,
      password: share.password,
    })),
    album: { id: album.id, name: album.name, fileIds: photoIds.slice(0, 3) },
  };

  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  owner.sdk.dispose();
  member.sdk.dispose();
  process.stdout.write(
    `SEEDED ${files.length} owner files (${files.reduce((sum, file) => sum + file.size, 0)} bytes), ` +
      `${files.reduce((sum, file) => sum + file.versions.length, 0)} versions, ${shares.length} shares, ` +
      `1 member file, album of ${photoIds.slice(0, 3).length} → ${manifestPath}\n`,
  );
}

async function verify() {
  const manifest = await readManifest(manifestPath);
  const owner = await signIn(manifest.owner.email, manifest.owner.password);
  const failures: string[] = [];
  let bytes = 0;
  let checked = 0;

  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  const trash = await owner.sdk.rpc.files.list({ view: "trash" });

  for (const record of manifest.files) {
    // Trashed items are only visible through the Trash view and cannot be downloaded.
    if (record.trashed) {
      const entry = trash.items.find((item) => item.id === record.id);
      check(entry?.size === record.size, `${record.path}: missing from Trash`);
      continue;
    }

    const entry = await owner.sdk.rpc.files.get({ id: record.id });
    check(entry.size === record.size, `${record.path}: size ${entry.size} ≠ ${record.size}`);
    const read = await download(owner, record.id);
    check(read.sha256 === record.sha256, `${record.path}: SHA-256 mismatch`);
    bytes += read.bytes;
    checked++;
    const versions = await owner.sdk.rpc.files.versions({ id: record.id });
    check(
      JSON.stringify(versions.items.map((version) => version.id).toSorted()) ===
        JSON.stringify(record.versions.map((version) => version.id).toSorted()),
      `${record.path}: version list differs`,
    );

    for (const version of record.versions) {
      const readVersion = await download(owner, record.id, version.id);
      check(
        readVersion.sha256 === version.sha256,
        `${record.path}@${version.id}: SHA-256 mismatch`,
      );
      bytes += readVersion.bytes;
      checked++;
    }
  }

  for (const expected of manifest.shares) {
    const listed = await owner.sdk.rpc.shares.list({ itemId: expected.itemId });
    const actual = listed.items.find((share) => share.id === expected.id);
    check(
      Boolean(actual) &&
        actual!.role === expected.role &&
        actual!.public === expected.public &&
        !actual!.revokedAt,
      `share ${expected.id} missing or changed`,
    );
  }

  const anonymous = connect(gateway);

  for (const expected of manifest.shares.filter((share) => share.public && share.url)) {
    const token = new URL(expected.url!, gateway.origin).pathname.split("/").at(-1)!;

    const resolved = expected.password
      ? await anonymous.sdk.rpc.shares.unlock({ token, password: expected.password })
      : await anonymous.sdk.rpc.shares.resolve({ token });

    check(resolved.item?.id === expected.itemId, `public share ${expected.id} does not resolve`);
  }

  const users = await owner.sdk.rpc.admin.users({});
  check(
    [manifest.owner.id, manifest.member.id].every((id) =>
      users.items.some((user) => user.id === id),
    ),
    "admin user list lost an account",
  );
  const albums = await owner.sdk.rpc.photos.albums({});
  const album = albums.items.find((item) => item.id === manifest.album.id);
  check(album?.count === manifest.album.fileIds.length, "album missing or count changed");
  const member = await signIn(manifest.member.email, manifest.member.password);
  const shared = await member.sdk.rpc.files.list({ view: "shared" });
  check(
    shared.items.some((item) => item.id === manifest.folders.Photos),
    "member lost the shared Photos folder",
  );

  for (const record of manifest.memberFiles) {
    const read = await download(member, record.id);
    check(read.sha256 === record.sha256, `member ${record.path}: SHA-256 mismatch`);
    bytes += read.bytes;
    checked++;
  }

  owner.sdk.dispose();
  member.sdk.dispose();
  anonymous.sdk.dispose();

  if (failures.length) {
    process.stdout.write(`VERIFY FAILED (${failures.length}):\n${failures.join("\n")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `VERIFIED ${checked} file/version downloads (${bytes} bytes) by SHA-256, ` +
      `${manifest.shares.length} shares (public links resolved anonymously), 2 accounts, 1 album\n`,
  );
}

if (command === "seed") await seed();
else if (command === "verify") await verify();
else throw new Error("Usage: ops-dataset.ts seed|verify --origin … --manifest …");

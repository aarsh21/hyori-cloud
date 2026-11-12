# Backup and restore

Hyori keeps metadata in PostgreSQL and file bytes in RustFS. A backup needs both, taken so that every object the database refers to is in the backup. `scripts/ops-backup.ts` does that while the stack keeps serving users. Trash and version history are not backups.

## What a backup contains

| File | Contents |
| --- | --- |
| `postgres.dump` | One consistent `pg_dump --format=custom` snapshot of the `hyori` database |
| `objects/` | Every object in the bucket, at its object key |
| `env.deployment` | A copy of the deployment env file (mode 0600). A restore needs the same `HYORI_AUTH_SECRET` |
| `backup.json` | Schema version, image IDs, dump SHA-256, object counts and `snapshotStartedAt` |

The backup holds every credential and every user's files. Keep it encrypted, off the host, and readable only by the operator. The tool creates the directory with mode 0700.

## Why the online backup is consistent

Object keys are server-generated (`owners/{owner}/{id}`), unique and never rewritten. A key either holds its final bytes or does not exist. The tool runs four steps:

1. Copy every object from the bucket.
2. Take one `pg_dump` snapshot.
3. Copy the bucket again. This picks up objects committed after step 1 but before the snapshot.
4. Read every key that the dump references (current files, retained versions, ready thumbnails), and **fail** unless each one is in the backup.

Objects deleted after the snapshot are only ever deleted from the bucket, never from the backup. Extra objects in the backup are orphans: harmless, and reported in `backup.json`.

The restore point is the database snapshot. Work acknowledged before `snapshotStartedAt` is in the backup. Work acknowledged after it may be missing after a restore, which is expected for any point-in-time backup. Uploads still in progress at snapshot time cannot be resumed after a restore, because their partial multipart data is not copied. Users upload those files again.

## Take a backup

Requirements: Docker with the Compose plugin, Bun 1.4.4, and free disk space at least the size of the bucket plus the dump. The tool pulls one extra image, `rclone/rclone` pinned by digest. rclone runs on the project's private network and reads the storage credentials from the env file.

```sh
bun scripts/ops-backup.ts backup /srv/backups/hyori-$(date -u +%Y%m%dT%H%M%SZ)
```

Options: `--project` (default `hyori-cloud-rust`) and `--env-file` (default `.env.deployment`). The target directory must be new or empty. Each backup is a full copy. For retention, use your backup system's deduplication or snapshots of the backup directory. Because objects are immutable, deduplication works well on them.

The last line must read `BACKUP OK … all N referenced keys present`. Any other ending means the backup is not usable. The tool exits non-zero.

## Restore

Restore only into a **fresh** Compose project, with no volumes. The tool refuses a project that already has volumes, or a database that has tables.

1. Make an env file for the new stack. Start from the backup's `env.deployment`. Keep `HYORI_AUTH_SECRET`. You may change `APP_ORIGIN`, `HYORI_WEB_PORT`, the PostgreSQL password (and the matching `HYORI_DATABASE_URL`), the storage keys and the bucket name. The dump contains no database role passwords.
2. Use the same images as the backup, or newer ones. `backup.json` records the image IDs. A newer backend applies its migrations on start; see [upgrades](operations.md#upgrades).
3. Run:

   ```sh
   bun scripts/ops-backup.ts restore /srv/backups/hyori-… --project hyori-restored --env-file /path/to/new.env
   ```

   The tool checks the dump's SHA-256. It starts only PostgreSQL and RustFS, restores the dump in one transaction (`pg_restore --single-transaction --exit-on-error`), uploads the objects and checks the bucket's object count. Then it starts the backend and web host and waits for their health checks.
4. Point your gateway at the new web port and check the data, as below.

## Verify a restore

`scripts/ops-dataset.ts verify` reads a seeded dataset back through the public SDK over the gateway. It hashes every file and every version, resolves public shares anonymously, and checks accounts and albums. Use it in restore drills:

```sh
bun scripts/ops-dataset.ts seed   --origin https://cloud.example --manifest m.json --setup-token "$HYORI_SETUP_TOKEN"   # once, on a test stack
bun scripts/ops-churn.ts          --origin https://cloud.example --manifest m.json --log churn.jsonl --seconds 120       # traffic during the backup
bun scripts/ops-dataset.ts verify --origin https://restored.example --manifest m.json
bun scripts/ops-churn.ts check    --origin https://restored.example --manifest m.json --log churn.jsonl --before <snapshotStartedAt>
```

Pass `--ca root.crt` when the gateway uses a private CA. The manifest holds the fixture accounts' passwords; keep it private.

## Evidence

Measured on 2026-11-12 on a 2-vCPU / 3.8 GiB orb, against the Compose stack built from 6b08373, through a Caddy TLS gateway:

- The backup ran while two churn workers uploaded, replaced, trashed and downloaded continuously (1,364 operations, 0 failed). It took 5.7 s for 122 objects (387 MB) and a 124 kB dump, and all 118 referenced keys were present.
- The restore into a new project took 22.9 s. Then `ops-dataset.ts verify` passed: 17 file and version downloads (214,515,252 bytes) by SHA-256, 3 shares, 2 accounts and 1 album. `ops-churn.ts check --before <snapshot>` found 56/56 acknowledged files intact.
- New uploads, replacements and downloads on the restored stack: 161 operations, 0 failed.
- A second run, after the drills, with a larger bucket and two churn workers (644 operations, 0 failed): the backup took 43.4 s for 2,338 objects (4.33 GB) and a 1.06 MB dump, with all 2,332 referenced keys present and 6 orphans. The restore took 71.3 s (50 s of it uploading objects). `verify` passed, and `check --before <snapshotStartedAt>` found 184/184 files intact; 27 files changed between `snapshotStartedAt` and the dump were skipped as indeterminate. One of those, trashed 47 ms after `snapshotStartedAt`, is correctly trashed in the restore, as on the source.

## Not covered

- Point-in-time recovery between backups (PostgreSQL WAL archiving and object versioning) is not provided.
- The tool backs up one Compose deployment on one host. It does not encrypt or ship backups off the host; do that with your backup system.
- There is no importer for legacy (TypeScript/SurrealDB) deployment data.

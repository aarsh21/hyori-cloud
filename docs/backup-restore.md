# Backup and restore

Hyori keeps metadata in PostgreSQL and file bytes in RustFS. A backup needs both, taken so that every object the database refers to is in the backup. `scripts/ops-backup.ts` does that while the stack keeps serving users. Trash and version history are not backups.

## What a backup contains

| File             | Contents                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `postgres.dump`  | One consistent `pg_dump --format=custom` snapshot of the `hyori` database                   |
| `objects/`       | Every object in the bucket, at its object key                                               |
| `env.deployment` | A copy of the deployment env file (mode 0600). A restore needs the same `HYORI_AUTH_SECRET` |
| `backup.json`    | Schema version, image IDs, dump SHA-256, object counts and `snapshotStartedAt`              |

The backup holds every credential and every user's files. Keep it encrypted, off the host, and readable only by the operator. The tool creates the directory with mode 0700.

## Scheduled backups (Docker Compose only)

The base stack starts a `backup` service. No host Bun, cron, Docker socket, or extra network port is needed. It runs the same two object-copy passes, consistent database dump and referenced-key verification as the manual tool, using PostgreSQL and RustFS on the private Compose network. It starts a backup immediately, then waits `HYORI_BACKUP_INTERVAL_SECONDS` after each completed attempt (default 86400 seconds). Only one backup runs at a time. Each backup is a full copy: provision space for the retained copies **plus one in progress**.

Set these in `.env.deployment`:

| Setting                         | Default | Meaning                                                                |
| ------------------------------- | ------- | ---------------------------------------------------------------------- |
| `HYORI_BACKUP_INTERVAL_SECONDS` | 86400   | Delay between completed attempts                                       |
| `HYORI_BACKUP_KEEP`             | 7       | Number of complete backups retained                                    |
| `HYORI_BACKUP_MAX_AGE_SECONDS`  | 90000   | Maximum age of the last successful backup; must exceed the interval    |
| `HYORI_BACKUP_TIMEOUT_SECONDS`  | 3600    | Abort and restart the backup container if a run hangs longer than this |

The `rust-backups` named volume holds `backup-<epoch-milliseconds>/` directories. A run first writes `.partial-…`; only a validated backup is renamed to `backup-…`. Retention deletes the oldest complete backups only after a new valid backup exists. Failed partial copies are removed, including after a restart. Keep this volume dedicated to the scheduler; do not store manual backups there. `docker compose down -v` destroys it along with the live data: **never use that command on a deployment you need to keep**.

`docker compose --env-file .env.deployment ps backup` is the failure signal. It starts as `starting`, becomes healthy only after a success, and becomes unhealthy after the 30-second startup grace if no backup has succeeded. A failed attempt or an overdue last success also makes it unhealthy, even if the scheduler is stuck. A normal success clears the failure. Docker does **not** restart containers just because they are unhealthy. Monitor this health state with your host/container alerting and page an operator on `unhealthy`, `restarting`, missing or stopped. This is a visible failure signal, not an email/push notification service. Inspect `docker compose --env-file .env.deployment logs backup` for `scheduled_backup` records.

The volume root and backup directories are 0700; files, including the deployment credential snapshot, are 0600 (`umask 077`). The live credential snapshot is in a private tmpfs, not a world-readable rclone config. Credentials still exist in Docker's container environment and are visible to Docker administrators. Protect the host `.env.deployment` with `chmod 600`. The sidecar runs as root with all capabilities dropped to own its private volume; it has no Docker socket or live-data filesystem mounts. Its CPU, memory and PID caps are overridable with `HYORI_BACKUP_CPUS`, `HYORI_BACKUP_MEMORY`, and `HYORI_BACKUP_PIDS`.

To export a complete scheduled backup for the existing restore tool, list the volume and copy one directory outside it (substitute its actual name):

```sh
docker compose --env-file .env.deployment exec backup ls -1 /backups
mkdir -m 700 /srv/hyori-restore-input
docker compose --env-file .env.deployment cp backup:/backups/backup-<timestamp> /srv/hyori-restore-input/
```

Use `/srv/hyori-restore-input/backup-<timestamp>` as the restore input below. Scheduled backups use the same format, but `images` is empty: without the Docker socket the sidecar cannot inspect running image IDs. Record the deployed image digests with your release records and preserve them for a restore. Encryption and off-host shipping remain the operator's responsibility; a local volume does not protect against host loss or ransomware.

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

Options: `--project` (default `hyori-cloud-rust`) and `--env-file` (default `.env.deployment`). The target directory must be new or empty. Each backup is a full copy. The scheduled service prunes its own copies; manual backup retention belongs to your backup system. Because objects are immutable, deduplication works well on them.

The last line must read `BACKUP OK … all N referenced keys present`. Any other ending means the backup is not usable. The tool exits non-zero.

## Restore

Restore only into a **fresh** Compose project, with no volumes. The tool refuses a project that already has volumes, or a database that has tables.

1. Make an env file for the new stack. Start from the backup's `env.deployment`. Keep `HYORI_AUTH_SECRET`. You may change `APP_ORIGIN`, `HYORI_WEB_PORT`, the PostgreSQL password (and the matching `HYORI_DATABASE_URL`), the storage keys and the bucket name. The dump contains no database role passwords.
2. Use the same images as the backup, or newer ones. `backup.json` records the image IDs. A newer backend applies its migrations on start; see [upgrades](operations.md#upgrades).
3. Run:

   ```sh
   bun scripts/ops-backup.ts restore /srv/backups/hyori-… --project hyori-restored --env-file /path/to/new.env
   ```

   The tool checks the dump's SHA-256. It starts only PostgreSQL and RustFS, restores the dump in one transaction (`pg_restore --single-transaction --exit-on-error`), uploads the objects and checks the bucket's object count. Then it starts the backend and web host and waits for their health checks. It starts the backup service separately without waiting for its first copy: a large initial backup or a backup failure must not block application recovery. Check backup health separately.

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

### Scheduled-backup blocker round

The operations changes on top of e3225e8 were checked on repository-Dockerfile images, including backend `sha256:04459ddac036`, web `sha256:b6d719bef82d` and backup `sha256:a90c8319e91d`. The scheduler used a three-second interval, keep-two retention, a 30-second freshness threshold and a 120-second run timeout for the drill; production defaults remain daily / keep seven / 25-hour freshness / one-hour timeout.

- Three fresh scheduled successes left exactly two complete backups. All backup files and directories had no group/world permission bits; the volume was 0700 and the live credential snapshot 0600.
- A deliberately incorrect password on **only the backup service** made the next real backup fail and its Docker health turn unhealthy, without deleting the two good backups. Restoring the password recovered healthy status.
- Pausing the scheduler process with SIGSTOP aged out a successful backup and made health unhealthy with **no failure marker**. SIGCONT allowed a new success and health recovered.
- An exported scheduled snapshot contained schema 19, a 181,589-byte dump and all 72 referenced objects (611,262,718 bytes), with zero orphans. The existing restore tool loaded it into the independent `operations-restored` Compose project. Through that project's TLS gateway, all 30 file/version downloads (432,218,783 bytes) matched their independent SHA-256 values; three shares, two accounts and the album also verified.
- A second fresh restore, with deliberately incorrect credentials on only its backup service, still returned `RESTORE OK` and the same hash verification. Docker showed web healthy and backup unhealthy; correcting the backup credentials recovered its health. This exercises the separate startup waits rather than hiding a failed backup behind application health.
- The first 1024 MiB RustFS limit was rejected after repeated backups caused a real cgroup OOM. RustFS restarted and the fixture still verified. The full schedule/retention/failure/freshness drill passed with **2048 MiB RustFS and zero RustFS restarts**; a 100 ms sampler saw 832.2 MiB raw / 826.6 MiB working memory. See the aggregate host budget in [operations](operations.md#runtime-resource-budgets).

These are short, accelerated drills, not a multi-day soak or proof for an arbitrary library. A scheduled local copy is still not off-host or encrypted, and Docker health still needs operator alerting.

## Not covered

- Point-in-time recovery between backups (PostgreSQL WAL archiving and object versioning) is not provided.
- The tool backs up one Compose deployment on one host. It does not encrypt or ship backups off the host; do that with your backup system.
- There is no importer for legacy (TypeScript/SurrealDB) deployment data.

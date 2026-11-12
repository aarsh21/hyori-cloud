# Backup and restore

Hyori keeps metadata in PostgreSQL and file bytes in RustFS. A backup needs both, taken so that every object the database refers to is in the backup. `scripts/ops-backup.ts` does that while the stack keeps serving users. Trash and version history are not backups.

## What a backup contains

| File             | Contents                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `postgres.dump`  | One consistent `pg_dump --format=custom` snapshot of the `hyori` database                   |
| `objects/`       | Objects at their immutable keys; scheduled snapshots keep exactly the dump's references     |
| `env.deployment` | A copy of the deployment env file (mode 0600). A restore needs the same `HYORI_AUTH_SECRET` |
| `backup.json`    | Schema version, image IDs, dump SHA-256, object counts and `snapshotStartedAt`              |

The backup holds every credential and every user's files. Keep it encrypted, off the host, and readable only by the operator. The tool creates the directory with mode 0700.

## Scheduled backups (Docker Compose only)

The base stack starts a `backup` service. No host Bun, cron, Docker socket, or extra network port is needed. It runs two object-copy passes, a consistent database dump and referenced-key verification using PostgreSQL and RustFS on the private Compose network. It starts immediately, then waits `HYORI_BACKUP_INTERVAL_SECONDS` after each completed attempt (default 86400 seconds). Only one backup runs at a time.

Each scheduled snapshot is independently restorable, but unchanged immutable objects are **hard-linked** from the previous complete snapshot, not copied again. New objects stream through one space-checked writer; rclone only lists/reads S3 and never writes linked destination files. Existing files are never opened for writing, and new files use exclusive creation. After validating every key referenced by the dump, the tool unlinks unreferenced objects from the new snapshot. A file deleted between snapshots is absent from the newer one; older snapshots retain it. Retention unlinks directory entries without changing files that newer snapshots still reference. The backup volume must support POSIX hard links; failure never falls back to unbounded full copies.

Set these in `.env.deployment`:

| Setting                         | Default | Meaning                                                                                          |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `HYORI_BACKUP_INTERVAL_SECONDS` | 86400   | Delay between completed attempts                                                                 |
| `HYORI_BACKUP_KEEP`             | 7       | Number of complete backups retained                                                              |
| `HYORI_BACKUP_MAX_AGE_SECONDS`  | 90000   | Maximum age of the last successful backup; must exceed the interval                              |
| `HYORI_BACKUP_TIMEOUT_SECONDS`  | 3600    | Abort and restart the backup container if a run hangs longer than this                           |
| `HYORI_BACKUP_RESERVE_PERCENT`  | 25      | Minimum available bytes as a percentage of the backup filesystem's total capacity; integer 16–99 |

The `rust-backups` named volume holds `backup-<epoch-milliseconds>/` directories. A run first writes `.partial-…`; only a validated backup is renamed to `backup-…`. Retention deletes the oldest complete backups only after a new valid backup exists. Failed partial copies are removed, including after a restart. Keep this volume dedicated to the scheduler; do not store manual backups there. `docker compose down -v` destroys it along with the live data: **never use that command on a deployment you need to keep**.

Budget disk for the union of objects referenced by all retained snapshots, new bucket objects for one in-progress run, each snapshot's database dump, and filesystem metadata, **plus the reserve**. Retained deleted/replaced files still consume space until their last snapshot is pruned. Measure the whole backup directory with `du`; adding separately measured snapshot sizes double-counts hard links. Legacy full-copy snapshots are not converted in place. If they already leave less than the reserve, add capacity or export and verify a good backup off-host before removing obsolete snapshots; the scheduler will not delete good backups to make a new attempt fit.

### Disk reserve and run deadline

The default 25% reserve is above the monitoring overlay's 15% low-disk alert. Available bytes exclude filesystem-reserved blocks. Space is checked before each run, before creating links/metadata or copying a new object, and before every write of at most 64 KiB to an object or the database dump, with another 64 KiB of metadata headroom. A supervisor also checks every 250 ms so low space can stop a run blocked on a database or storage read. Insufficient space terminates the run, removes its partial snapshot, records failure and logs the fixed `scheduled_backup` status `insufficient_space`. Health is unhealthy until space is sufficient and a subsequent backup succeeds; it also checks free space independently of the failure marker.

The reserve controls backup writes, **not other services' writes**; it is not a filesystem quota or reserved partition. By default Docker's backup, RustFS and PostgreSQL volumes usually share one host filesystem. Monitor that filesystem and prefer a dedicated backup filesystem for failure isolation. Other writers can consume the headroom, and another filesystem holding live data needs its own capacity alert. Backups on the live-data disk still do not protect against host or disk loss.

The default run deadline is **one hour**, including both bucket listings, linking, downloads, dumping, validation and publication. A longer run is killed and retried by the container restart policy; it cannot publish a backup. Size `HYORI_BACKUP_TIMEOUT_SECONDS` from a measured full first run and a representative worst-change run, with at least 2× margin. Estimate transfer time from new bytes divided by measured conservative throughput, add database dump/list/link/validation time and per-new-object process overhead. Downloads are serial and start one rclone reader per new object, so a library of many small files needs its own measurement; unchanged files are not downloaded again.

For example, a measured three-hour first run needs at least `HYORI_BACKUP_TIMEOUT_SECONDS=21600` (six hours). With a daily completion-relative interval, `HYORI_BACKUP_MAX_AGE_SECONDS=111600` allows that six-hour run plus one hour of margin. Always make max age exceed interval + worst successful run duration + alert margin. The initial backup is unprotected until it succeeds, so an initial long copy can legitimately show unhealthy after the startup grace. Rehearse the first backup before treating a deployment as protected.

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

Objects referenced by the snapshot remain in that backup even if subsequently deleted from the bucket. Manual copies can contain harmless orphans, reported in `backup.json`; scheduled snapshots unlink only objects the dump does not reference, after the reference check. No current bucket listing is used to delete a snapshot-referenced key.

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

### Disk-reserve and hard-link follow-up

The follow-up used repository-Dockerfile images: backend `sha256:04459ddac036`, web `sha256:6a548215b09e`, backup `sha256:cc69407400ad`. RustFS live objects and backup snapshots shared a **768 MiB ext4 loop filesystem**, with 774,307,840 total bytes reported by `statfs`. PostgreSQL stayed on its ordinary Docker volume. The fixture used `ops-dataset.ts seed --large-mib 8` plus auxiliary files, through a real TLS gateway. The scheduled interval was three seconds, freshness 180 seconds and timeout 120 seconds.

- **Before, on 429506d:** five full-copy scheduled snapshots left too little space for a new 64 MiB upload. The next scheduled copy filled the filesystem to zero available bytes; that SDK upload failed with `Upload part failed (503)` in 7.417 seconds. The test then retained one good baseline snapshot and removed only the disposable duplicate copies to prepare the guarded run; this does not imply automatic in-place conversion of legacy backups.
- **Reuse:** one, two and three new unchanged snapshots used 123,932,672 / 124,055,552 / 124,178,432 physical bytes in total, for 123,765,863 logical object bytes per snapshot. A permanently deleted 1 MiB auxiliary file remained hash-intact in the older snapshot and was absent from the newer one. Pruning to two snapshots preserved all 23 common files' bytes, SHA-256 values and shared inode identities.
- **During-copy guard:** a newly uploaded 16 MiB object was read at a test-only 2 MiB/s to expose the copying window. After 5,238,784 bytes were written, separate test padding reduced available space to 201,961,472 bytes, still above the 193,576,960-byte (25%) reserve. The run stopped with `insufficient_space` after 7.153 seconds, removed its partial, and Docker health became unhealthy after 15.652 seconds. A 10 ms sampler's minimum during backup writing was **193,683,456 bytes**, above the reserve. While that failure and padding remained, the **same 64 MiB source and filename** uploaded and downloaded intact in 3.649 seconds. Live writes may consume the headroom; the reserve is not a live-upload quota.
- **Recovery and restore:** removing the test padding allowed three successful scheduled runs and healthy status again, without resizing the filesystem. The newest keep-two snapshot held all 25 referenced objects (206,603,367 bytes), zero orphans and an 87,363-byte checksum-verified dump. `docker compose cp` exported that single linked snapshot; the existing restore tool returned `RESTORE OK` into the separate `operations-restored` project in 31.2 seconds. `ops-dataset.ts verify` passed all 17 file/version downloads (97,101,758 bytes), three shares, two accounts and the album. All three auxiliary files, including the acknowledged pressure upload, also matched their independent source hashes (109,051,904 bytes); the deleted file stayed absent. No backup directory/file had group/world permission bits; root and live credentials remained 0700 / 0600.

These are accelerated single-host checks, not an arbitrary-filesystem guarantee, an unbounded-concurrent-writer isolation test, or a large-library soak. The filesystem reserve is checked admission, not an atomic reservation against unrelated writers.

## Not covered

- Point-in-time recovery between backups (PostgreSQL WAL archiving and object versioning) is not provided.
- The tool backs up one Compose deployment on one host. It does not encrypt or ship backups off the host; do that with your backup system.
- There is no importer for legacy (TypeScript/SurrealDB) deployment data.

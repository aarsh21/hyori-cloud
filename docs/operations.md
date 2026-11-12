# Operating the Compose deployment

This page covers what was verified about running `docker-compose.yml` in production, and what is still missing. For backups see [backup and restore](backup-restore.md); for editors see [editor deployment](editor-deployment.md).

## Bring-up

Requirements: Docker Engine with the **Compose v2 and Buildx plugins** (`docker compose`, `docker buildx`), Bun 1.4.4 for the tooling, and a TLS gateway on the same host.

1. Create `.env.deployment` from `.env.deployment.example`. Hex secrets avoid URL-encoding the PostgreSQL password in `HYORI_DATABASE_URL`:

   ```sh
   pg=$(openssl rand -hex 24)
   # POSTGRES_PASSWORD=$pg and HYORI_DATABASE_URL=postgres://hyori:$pg@postgres:5432/hyori
   # HYORI_SETUP_TOKEN=$(openssl rand -hex 24), HYORI_AUTH_SECRET=$(openssl rand -hex 32)
   # HYORI_STORAGE_ACCESS_KEY=$(openssl rand -hex 12), HYORI_STORAGE_SECRET_KEY=$(openssl rand -hex 24)
   ```

   `APP_ORIGIN` must be exactly the address users type: `https://`, the gateway's host, the port only if it is not 443, and **no trailing slash**. A trailing slash or `http://` stops the backend at startup with `ConfigError("origin must be exact; production requires HTTPS")`. A different host starts normally, but every API call then fails with 403 `Unexpected request authority`.
2. `bun run docker:up` builds the three images and starts the stack. On 2 cores a cold build takes about 13 minutes (backend 9m47s, media worker 2m12s, web 42s). Do not build while the stack serves users on a 4 GB host. Two `rustc` processes held about 2.2 GB and starved the running stack.
3. Put a gateway in front of the loopback web port. A minimal Caddy site for the base stack, with Caddy on the host:

   ```caddyfile
   cloud.example.com {
       reverse_proxy 127.0.0.1:3001 {
           header_up -Forwarded
       }
   }
   ```

   The handler in [editor deployment](editor-deployment.md) uses `web:3001`. That only works when Caddy runs on the Compose network. The shipped Compose file has no gateway service, so a host Caddy uses `127.0.0.1:${HYORI_WEB_PORT}`.
4. Open the site and complete setup with `HYORI_SETUP_TOKEN`.

## What an operator can observe today

| Signal | Where | What it tells you |
| --- | --- | --- |
| `docker compose ps` | Docker | `Restarting (1)` on the backend means it fails at startup |
| Backend `/health/live`, `/health/ready` | Backend port 3002, private network only | Ready means the database answers `SELECT 1`. RustFS and the media worker are not checked. Compose does not probe these: the backend image has no HTTP client and the backend service has no health check |
| Web health check | `GET /` inside the web container | The SSR page renders. It stays **healthy while the backend is down**, and `GET /` still returns 200 |
| PostgreSQL health check | `pg_isready` | The database accepts connections |
| RustFS health check | `GET /health` (added in this review) | The object store is up. The backend now waits for it on start |
| Media worker health check | Its socket exists | — |
| Backend logs | `docker compose logs backend` | Startup line, maintenance warnings, database errors with SQLSTATE. No request log and no per-request failure detail |
| Web host logs | `docker compose logs web` | Startup only. Rejected requests (wrong origin or host) are not logged |
| RustFS logs | Container stdout | Three startup lines. The `/logs` volume stays empty, and a full disk is not logged |

There are no metrics, alerts, request logs, log shipping or tracing.

### Misconfiguration, as an operator sees it

Each case was applied to a running stack. Every one leaves the web container `healthy` and `GET /` at 200, so users load the page and then every API call fails.

| Mistake | Backend | Log line the operator gets | Users see |
| --- | --- | --- | --- |
| Wrong storage secret key | Crash loop (7 restarts in 12 s) | `Error: ApiError { code: Unavailable, message: "Service temporarily unavailable" }` only | 503 `service.unavailable` "The backend is unavailable; retry shortly" |
| Wrong database password | Crash loop | `database operation failed category="database" sqlstate="none"`, then the same opaque line | 503 as above |
| Database host unreachable | Crash loop | Identical to the wrong password | 503 as above |
| Storage endpoint unreachable | Crash loop | The opaque line only | 503 as above |
| Invalid bucket name (stands in for missing bucket permission; see below) | Crash loop | The opaque line only | 503 as above |
| `APP_ORIGIN` with `http://` or a trailing `/` | Crash loop | `ConfigError("origin must be exact; production requires HTTPS")` | 503. With `http://`, "Server configuration is incomplete. Configure the private Rust backend." |
| `APP_ORIGIN` host differs from the gateway host | Runs | Nothing | 403 `access.denied` "Unexpected request authority" on every call |

Only the origin errors name their cause. The storage and database failures cannot be told apart from the logs. The backend maps them all to `ApiError::unavailable()` in `AppState::connect`. A storage user without bucket permission takes the same `ensure_bucket` path (a non-404 `head_bucket` error); that conclusion comes from reading the code. It was not reproduced, because the MinIO admin client needed to create a restricted RustFS user is no longer distributed (Docker Hub denies the pull, quay.io returns 401, dl.min.io returns 410).

## Failure behaviour

Drills used `scripts/ops-drills.ts` with two `ops-churn.ts` workers uploading, replacing, trashing and downloading. The seeded dataset (`ops-dataset.ts`) was verified by SHA-256 after every drill. Host: a 2-vCPU / 3.8 GiB orb, with no other load except where noted.

| Drill | What users saw | Recovery | Data |
| --- | --- | --- | --- |
| `docker compose restart` of postgres, rustfs, media-worker, backend, web, one at a time | Brief errors only | Serving again ≤ 1.1 s after each restart | Dataset intact |
| Backend SIGKILL during a 160 MiB upload, at 64 MiB | Upload fails with `service.unavailable`. The SDK's 2 automatic retries (250 ms apart) end before the backend is back (0.8 s) | A user **Retry** resumed from the 64 MiB checkpoint and completed | Upload intact; dataset intact |
| Backend SIGKILL during a 120 MiB download, at 44 MiB | Stream fails with `ECONNRESET`; never a silently short file | Downloading again succeeds | Intact |
| RustFS stopped 20 s under load | Uploads fail with `service.unavailable`, `Upload part failed (503)` or a **gateway 502** (see below). Downloads fail with `ECONNRESET` | 501 operations succeeded after it returned; the backend never restarted | 230/230 acknowledged files intact |
| PostgreSQL stopped 20 s under load | Uploads fail with `service.unavailable`; requests stall up to the 10 s pool timeout first | 536 operations succeeded after it returned; no backend restart | 234/234 acknowledged files intact |
| Storage volume full (600 MiB loop device) | Uploads fail with `service.unavailable` or a gateway 502. **Nothing says storage is full, and nothing is logged** | Emptying Trash released the quota at once, but RustFS kept the deleted bytes in `.rustfs.sys/tmp/.trash` (378 MiB) and the disk stayed 100% full for at least 3 minutes. **Restarting RustFS purged it** (532 → 160 MiB used), then uploads worked | Every committed file intact |
| Two backend replicas (`--scale backend=2`) | Both started together; migrations ran under an advisory lock. The web host spread connections over both (929 MB and 316 MB of traffic) | — | 710 operations, 0 failed; 225/225 intact |

The gateway 502: during a RustFS outage, some `POST /api/rpc` calls (uploads waiting on storage) got a 502 from Caddy. Caddy reports `EOF` from the web host after about 5.5 s. The web host closed the connection without answering, so the client gets a non-JSON body that the SDK reports as `SDK_PROTOCOL: The server returned an invalid RPC envelope (502)`, not a retryable API error. This is an application issue in the web host's proxy, not in the deployment.

### Replicas

Running more than one backend works against one PostgreSQL and one RustFS. Migrations take an advisory lock, and maintenance claims work with leases. Two limits are per process, not per deployment: the per-principal download limit (8 per user) and the owner write queue. So two replicas allow a user 16 concurrent downloads and see more serialization retries. Keep `HYORI_DATABASE_MAX_CONNECTIONS` × replicas below PostgreSQL's `max_connections` (100 by default; the default pool is 48, so two replicas use 96). The web host has no sticky routing and needs none.

## Upgrades

The backend applies pending migrations at startup, in **one transaction** under `pg_advisory_xact_lock`, and checks the SHA-256 of every migration already applied. A failure midway rolls back every migration of that start. The database stays at the previous version, the backend exits, and Compose restarts it in a loop with the opaque `Unavailable` line. Rolling back the image after a successful migration is not automatic; take a backup before every upgrade.

Rehearsed on 2026-11-12 from `c582a6a`, the last commit before migrations 12–15 (schema 11), to 6b08373 (schema 15):

1. Started a fresh stack with the `c582a6a` backend image, then seeded and verified the dataset through the gateway: 17 downloads, 130,645,618 bytes.
2. **Failure midway.** Pre-created an index named `hyori_items_trash_age`, which migration 13 also creates, then started the 6b08373 backend. It crash-looped with `database operation failed category="database" sqlstate="42P07"`, followed by the opaque `Unavailable` line. PostgreSQL's own log named the relation (`relation "hyori_items_trash_age" already exists`). The schema stayed at 11, and migration 12's `hyori_uploads.clean_checks` column was absent: the whole start rolled back.
3. Dropped the conflicting index and restarted. Migrations 12–15 applied in one transaction (identical `applied_at`), and the dataset verified unchanged.
4. **Rollback direction.** Started the `c582a6a` image against schema 15. It ran, the dataset verified, and 10 s of churn had 196 operations with 0 failures. That is a short smoke test, not proof that an old backend is safe on a new schema for long.

To find a failed migration's cause, read `docker compose logs postgres`; the backend log gives only the SQLSTATE.

## Storage full

Watch the disk that holds the `rust-storage-data` volume yourself; nothing in the stack reports it. To recover:

1. Free space by deleting data in the product: empty Trash, or delete versions.
2. Restart RustFS with `docker compose --env-file .env.deployment restart rustfs`. RustFS 1.0.0-alpha.85 keeps deleted objects in `.rustfs.sys/tmp/.trash` until it restarts.
3. Check that uploads work again.

## Missing for production

- **Metrics and alerts.** There is no metrics endpoint for request rates, errors, latency, queue depth, transfer admission, database pool, storage usage or media job state.
- **Diagnosable startup errors.** Storage and database misconfigurations log one indistinguishable line (see the table above).
- **A real readiness signal in Compose.** The backend has no Compose health check (no HTTP client in the image), and the web health check passes while the backend is down.
- **Request logs.** Neither the web host nor the backend logs requests or rejected requests. Caddy's error log is currently the only per-request trace.
- **Log shipping.** Logs stay in Docker's json-file driver. This review added rotation (10 MB × 5 per container).
- **Resource limits.** Only the media worker is limited (1 CPU, 512 MiB). PostgreSQL, RustFS, the backend and the web host are unbounded; size them from the capacity measurements once those exist.
- **Storage monitoring.** A full disk produces generic upload failures and no log line, and space returns only after a RustFS restart.
- **RustFS maturity.** The object store is an alpha (`1.0.0-alpha.85`).
- **Backups.** `scripts/ops-backup.ts` works (see [backup and restore](backup-restore.md)), but nothing schedules it, ships it off the host or alerts when it fails.
- **Users.** The backend, media worker and RustFS run as UID 10001 and the web host as `node`. PostgreSQL's entrypoint starts as root and drops to `postgres`. The init containers run as root with every capability dropped except `CHOWN`/`FOWNER`.
- **Image pinning.** This review pinned every Compose image and web build base by digest. The Rust Dockerfiles were already pinned. The media worker's FFmpeg comes from Debian's archive at a pinned package version, which is reproducible only while Debian keeps that version.

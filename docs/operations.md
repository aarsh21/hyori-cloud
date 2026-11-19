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

2. Build images **before** starting the stack. `bun run docker:up` (or plain Compose `up -d --build`) builds four images, including the backup service. On a small host, build sequentially with one backend compiler job instead:

   ```sh
   docker compose --env-file .env.deployment build --build-arg CARGO_BUILD_JOBS=1 backend
   docker compose --env-file .env.deployment build --build-arg CARGO_BUILD_JOBS=1 media-worker
   docker compose --env-file .env.deployment build web backup
   docker compose --env-file .env.deployment up -d --no-build
   ```

   A two-job backend build stalled at the orb's 3 GiB workload cgroup limit on a 3.8 GiB physical host: two Rust compiler processes held about 1.9 GiB, before Cargo, Docker and tooling. Do not overlap it with web builds, test suites or a running deployment. The Dockerfile default remains two jobs; this is an operator build-time override, separate from runtime service limits. Earlier 2-core baseline cold builds took about 13 minutes (backend 9m47s, media worker 2m12s, web 42s); those timings do not establish a build deadline on a memory-constrained host.

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

## Runtime resource budgets

Every long-running service has CPU, memory and PID caps. The four application/data services use these defaults; each cell can be overridden in `.env.deployment` with the corresponding `HYORI_<SERVICE>_CPUS`, `HYORI_<SERVICE>_MEMORY`, or `HYORI_<SERVICE>_PIDS` setting. `memswap_limit` always equals the memory cap, so swap cannot hide a service exceeding its budget. The editor overlay inherits these same caps.

| Service / environment prefix  | CPUs | Memory             | PIDs |
| ----------------------------- | ---- | ------------------ | ---- |
| PostgreSQL / `HYORI_POSTGRES` | 1    | 512 MiB (`512m`)   | 128  |
| RustFS / `HYORI_RUSTFS`       | 1    | 2048 MiB (`2048m`) | 128  |
| Backend / `HYORI_BACKEND`     | 1.5  | 512 MiB (`512m`)   | 128  |
| Web / `HYORI_WEB`             | 1    | 512 MiB (`512m`)   | 128  |

The existing media worker remains 1 CPU / 512 MiB / 64 PIDs. Backup defaults are 0.5 CPU / 256 MiB / 64 PIDs. These are hard upper bounds, **not reservations** or throughput guarantees. The memory caps total 4352 MiB; reserve at least 1 GiB more for the OS, Docker and TLS gateway, and additional memory for other host applications. Plan on at least 6 GiB for the default aggregate budget. The measured small workload ran on a smaller orb, but that does not prove every service can reach its cap simultaneously there. Do not run a second full stack or build images inside that budget. A single service is contained, but quotas do not prevent host exhaustion from other processes or badly sized aggregate limits.

The initial sizing drill ran on a shared two-CPU / 3.8 GiB physical orb (3 GiB workload cgroup), with no swap, through a real TLS gateway and the public SDK. Work was a 160 MiB + 3 B multipart upload and SHA-256 readback, twelve new 2400×1600 JPEG thumbnails and their downloads, then eight concurrent independent-account sign-ins. A 100 ms cgroup-v2 sampler recorded these **pre-limit** peaks. The web image was built from e3225e8; the interim backend was a release binary from 98dc326 in the same Debian runtime, differing from e3225e8 only in slow-part storage timeouts. A one-job image build shared the host during this initial run, so the sampled CPU peaks are contention-dependent, not service capacity.

| Service    | Raw memory MiB | Working memory MiB | PIDs | Sampled CPU, % of one core |
| ---------- | -------------- | ------------------ | ---- | -------------------------- |
| PostgreSQL | 93.1           | 88.0               | 19   | 60.6                       |
| RustFS     | 270.3          | 119.7              | 16   | 50.1                       |
| Backend    | 166.9          | 158.6              | 11   | 123.6                      |
| Web        | 193.7          | 177.9              | 19   | 101.3                      |

Raw memory includes page cache; working memory here subtracts `inactive_file` (the Docker stats convention). Earlier larger-library/admission runs reached raw peaks of 536.8 MiB PostgreSQL, 1332.7 MiB RustFS, 327.9 MiB backend and 476.1 MiB web. Reclaimable cache is why a raw peak need not fit entirely below a future hard cap; the repeat under the actual caps is essential. The backend budget leaves room beyond the 128 MiB password hash while transfers stream. Admission permits sixteen concurrent upload operations, but this drill does not saturate all sixteen slots or establish a worst-case memory bound. PID caps allow the default 48-connection database pool, background processes, health checks and backup clients, not just idle thread counts.

The same work passed under the final default caps on the restored stack and repository-Dockerfile images, with no compiler or test suite competing: backend image `sha256:04459ddac036` and web image `sha256:b6d719bef82d`. The single run took 28.7 seconds, not a throughput guarantee. Peaks were:

| Service    | Raw memory MiB | Working memory MiB | PIDs | Sampled CPU, % of one core |
| ---------- | -------------- | ------------------ | ---- | -------------------------- |
| PostgreSQL | 106.5          | 90.4               | 19   | 90.6                       |
| RustFS     | 937.0          | 667.7              | 16   | 63.0                       |
| Backend    | 137.4          | 132.3              | 11   | 165.2                      |
| Web        | 131.6          | 118.1              | 19   | 144.0                      |

CPU samples are 100 ms windows and can straddle quota periods; a sampled burst above the configured CPU count is not sustained capacity. Docker inspect confirmed the enforced memory, CPU and PID values. Every service's three settings, and the linked swap cap, were also rendered successfully with independent environment overrides.

The upload workload alone was insufficient sizing evidence: repeated full scheduled backups of the 611 MB bucket made RustFS reach its 1024 MiB cgroup limit. The kernel recorded a cgroup OOM with about 1016 MiB anonymous RSS; Docker restarted RustFS automatically. All 30 file/version readbacks (432,218,783 bytes), three shares, both fixture accounts and the album verified intact afterwards. The default RustFS cap is therefore **2048 MiB**, not the rejected 1024 MiB candidate. This recovery is additional evidence to the deliberate web-process OOM drill; it is not a reason to accept a cap that kills normal backup work.

To size a larger host, first allocate memory to the OS/Docker/gateway and other applications, then distribute the remaining budget. For a 4-core / 8-GiB host, an initial **unbenchmarked** allocation is PostgreSQL 1 GiB / 2 CPUs, RustFS 2 GiB / 2 CPUs, backend 1 GiB / 2 CPUs and web 1 GiB / 2 CPUs, leaving the existing worker/backup caps and over 2 GiB for the host. Change only settings in `.env.deployment`, recreate with `docker compose --env-file .env.deployment up -d --no-build`, and rerun the drill below for your library, file sizes, photo/video formats and concurrency. Inspect `docker stats`, restart counts and cgroup `memory.events`; increase caps only when the aggregate host budget permits. Increasing CPUs/memory does not change product admission limits or PostgreSQL `max_connections`. Additional backend replicas each add their own memory and pool budget; see [replicas](#replicas).

Repeatable drill (Linux, cgroup v2; fixture credentials stay private). Seed with `ops-dataset.ts`, then run:

```sh
bun scripts/ops-resources.ts --origin https://cloud.example --manifest m.json --project hyori-cloud-rust --env-file .env.deployment
bun scripts/ops-drills.ts web-health --origin https://cloud.example --manifest m.json
bun scripts/ops-drills.ts oom-web --origin https://cloud.example --manifest m.json
```

Pass `--ca root.crt` for a private gateway CA. Resource runs append their acknowledged files and independent hashes to the fixture manifest, so later crash/restore checks cover them. Each resource run creates eight accounts; respect the administrator's ten-account-per-15-minute admission budget between repeats, rather than disabling it. `oom-web` is destructive **test-stack-only** tooling: it briefly enables Node's loopback-only inspector and allocates 2 GiB in the actual host process, verifies a Docker OOM event and automatic restart, then verifies the manifest. It never changes the production image or opens a host debugger port. Readiness checks and restarts alone do not prove durable data; the hash verification does.

On the same repository-built images, `web-health` changed web from healthy to unhealthy 47.8 seconds after stopping the backend, with readiness 503 and liveness 200; both returned generic bodies and `Cache-Control: no-store`. Web became healthy again 9.9 seconds after restarting the backend. `oom-web` recorded a real Docker cgroup OOM, a restart-count increase from zero to one and successful RPC recovery. Both drills finished with the 30 file/version downloads and fixture relationships intact.

After restoring the scheduled snapshot and repeating the workload under the final caps, a second `oom-web` run again recorded an OOM and automatic restart. All **43 file/version downloads (607,974,738 bytes)** then matched their source SHA-256 values, along with the same shares, accounts and album. This covers the newly acknowledged large upload and photo batch as well as the original restored fixture.

## Authentication secret rotation

Public link cookies are signed credentials, not stored grants: each lives at most 12 hours (less when the link expires sooner), and the server still checks on every request that the link exists, has not expired and has the same password. They are signed with a key derived from `HYORI_AUTH_SECRET`, so rotating that secret ends every open public link as well as every session: visitors open the link again, and unlock it again when it has a password.

### Browser cookies

Session and public-link grant cookies are HttpOnly, `SameSite=Strict`, `Path=/` and Secure on production HTTPS. They authorize access; a cross-site document navigation omits them and the browser recovers its session through same-origin requests without showing a signed-out screen first.

`hyori_ui` is instead a functional **preference** cookie, with no identifier, credential or file information. Its nine-character value (`2.l.o.1.0` by default) encodes version, List/Grid, open/collapsed sidebar, single-key shortcuts on/off and file sort (`0` Name A–Z, `1` Name Z–A, `2` Size ascending, `3` Size descending, `4` Modified ascending, `5` Modified descending). Previous seven-character v1 cookies such as `1.g.c.0` remain valid and imply Name A–Z. The browser writes `hyori_ui=<value>; Path=/; Max-Age=31536000; SameSite=Lax; Secure` on HTTPS (without `; Secure` on local HTTP). It is host-only, deliberately readable/writable by script, and travels with top-level cross-site GET navigation so signed-in Files and Shared can prefetch and render the right order and proportions. Public first documents still carry no listing or account data. Every malformed or duplicate value is rejected in full; it cannot grant access. Private, signed-out and public-share HTML all remain `Cache-Control: private, no-store`.

The existing localStorage choices win if the copies disagree. A nonce-authorized pre-paint guard hides only mismatched surfaces until the browser applies those choices, and rewrites the cookie for the next document. With cookies blocked this safe fallback repeats; with localStorage blocked, defaults apply on arrival and changes last only for that page. Like the previous browser-local choices, this cookie survives sign-out and another account on the same browser inherits the display choices, never the previous account's data. It needs no secret rotation and deleting it does not sign anyone out.

## What an operator can observe today

| Signal                                  | Where                                   | What it tells you                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose ps`                     | Docker                                  | `Restarting (1)` on the backend means it fails at startup                                                                                                                                                                                                                                         |
| Backend `/health/live`, `/health/ready` | Backend port 3002, private network only | The image runs `hyori-server --health` every 5 seconds, with a 3-second HTTP deadline and 3 failures before unhealthy (10-second startup grace). Ready means the database answers `SELECT 1`; RustFS and the media worker are not checked. The web service waits for backend readiness at startup |
| Web readiness and liveness              | `GET /health/ready`, `GET /health/live` | Ready checks the private backend's readiness with a two-second deadline; live checks only the host. Both bypass SSR and return generic, noncacheable bodies. Compose probes readiness every 10 seconds and fails after five consecutive errors                                                    |
| PostgreSQL health check                 | `pg_isready`                            | The database accepts connections                                                                                                                                                                                                                                                                  |
| RustFS health check                     | `GET /health` (added in this review)    | The object store is up. The backend now waits for it on start                                                                                                                                                                                                                                     |
| Media worker health check               | Its socket exists                       | —                                                                                                                                                                                                                                                                                                 |
| Backend logs                            | `docker compose logs backend`           | JSON [request summaries](monitoring.md#request-logs-and-metrics), startup and maintenance diagnostics, database errors with SQLSTATE, and storage failures with the owned storage operation and safe error details (HTTP status/S3 code or transport category).                                   |
| Web host logs                           | `docker compose logs web`               | One JSON `web_request` per incoming request, including SSR, assets and rejected proxy requests. Direct product API responses can [join to Rust request logs](monitoring.md#request-logs-and-metrics) by request ID. An unfinished connection records 499, not a successful transfer.              |
| RustFS logs                             | Container stdout                        | Three startup lines. The `/logs` volume stays empty, and a full disk is not logged                                                                                                                                                                                                                |

The `backup` container's health is also an operator signal: it becomes unhealthy after a failed attempt or when the last successful backup is too old. See [scheduled backups](backup-restore.md#scheduled-backups-docker-compose-only). Docker health is not an outbound notification; your host monitoring must alert on unhealthy, stopped, missing and restarting services. Log shipping and tracing are not configured here.

### Public web health bounds

The all-path Caddy example above forwards `/health/ready` and `/health/live`, so these paths **are publicly reachable** through that gateway. The same all-path TLS hop returned readiness 200 with `Cache-Control: no-store` in the Compose drill. Compose itself publishes only the loopback web port; a gateway can explicitly deny external health paths if they are not needed. Neither health endpoint authenticates, renders the app, or returns backend diagnostics. Readiness forwards no caller credentials, query strings or request body.

Each web process keeps at most one private backend readiness request in flight, with a two-second deadline, then reuses the resulting boolean for one second after completion, for **both success and failure**. Concurrent callers share the pending probe even after its first second. This bounds backend health traffic to at most one request per second per web process; replicas multiply that bound. The server-side reuse does not make public responses cacheable. An outage can leave a positive result stale for at most one second, followed by up to two seconds for the next probe; Compose's separate 10-second interval and five-failure threshold determine when its container becomes unhealthy. Liveness never waits on that probe. Gateway request-rate/connection protection is still needed; this is not a general web-host flood defense.

`bun test apps/web/test/backend-handler.test.ts --test-name-pattern coalesces` reproduced **80 backend probes for 80 concurrent callers** on 429506d. After the change, the same burst produces one; a stalled probe shared by another late burst returns generic 503 within the one-second reuse + two-second deadline (3300 ms test tolerance), failures are reused, and recovery starts a single new probe after expiry. In `sudo bun scripts/ops-drills.ts web-health --origin <TLS-origin> --ca <CA> --manifest <manifest> --project operations --env-file <env>`, repository-built web `sha256:6a548215b09e` turned unhealthy at 44.0 seconds from drill start and recovered 10.3 seconds after restarting the backend. Stopped-backend responses were readiness 503 / liveness 200, generic and `no-store`; the dataset then verified. Timings depend on the Compose probe phase, not just the one-second reuse.

Scheduled backups now enforce a default 25% free-space reserve, hard-link unchanged objects and mark low space as `insufficient_space`. This protects the default shared live-data disk from unbounded backup copies, but is not an atomic reservation against unrelated writers. See [disk reserve, timeout sizing and the measured shared-filesystem drill](backup-restore.md#disk-reserve-and-run-deadline) before changing retention or moving backups to another filesystem.

### Misconfiguration, as an operator sees it

Historical baseline (6b08373), before the web readiness change: each case was applied to a running stack. Every one left the web container `healthy` and `GET /` at 200. The current Compose readiness check instead goes unhealthy when the backend is unavailable; `/` remains a document response, not a readiness probe.

| Mistake                                                                  | Backend                         | Log line the operator gets                                                                 | Users see                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Wrong storage secret key                                                 | Crash loop (7 restarts in 12 s) | `Error: ApiError { code: Unavailable, message: "Service temporarily unavailable" }` only   | 503 `service.unavailable` "The backend is unavailable; retry shortly"                          |
| Wrong database password                                                  | Crash loop                      | `database operation failed category="database" sqlstate="none"`, then the same opaque line | 503 as above                                                                                   |
| Database host unreachable                                                | Crash loop                      | Identical to the wrong password                                                            | 503 as above                                                                                   |
| Storage endpoint unreachable                                             | Crash loop                      | The opaque line only                                                                       | 503 as above                                                                                   |
| Invalid bucket name (stands in for missing bucket permission; see below) | Crash loop                      | The opaque line only                                                                       | 503 as above                                                                                   |
| `APP_ORIGIN` with `http://` or a trailing `/`                            | Crash loop                      | `ConfigError("origin must be exact; production requires HTTPS")`                           | 503. With `http://`, "Server configuration is incomplete. Configure the private Rust backend." |
| `APP_ORIGIN` host differs from the gateway host                          | Runs                            | Nothing                                                                                    | 403 `access.denied` "Unexpected request authority" on every call                               |

Only the origin errors name their cause. The storage and database failures cannot be told apart from the logs. The backend maps them all to `ApiError::unavailable()` in `AppState::connect`. A storage user without bucket permission takes the same `ensure_bucket` path (a non-404 `head_bucket` error); that conclusion comes from reading the code. It was not reproduced, because the MinIO admin client needed to create a restricted RustFS user is no longer distributed (Docker Hub denies the pull, quay.io returns 401, dl.min.io returns 410).

## Failure behaviour

The baseline drills below used commit `6b08373`, `scripts/ops-drills.ts` and two `ops-churn.ts` workers uploading, replacing, trashing and downloading. The seeded dataset (`ops-dataset.ts`) was verified by SHA-256 after every drill. Host: a 2-vCPU / 3.8 GiB orb, with no other load except where noted. The subsequent reliability changes are described after the table.

| Drill                                                                                   | What users saw                                                                                                                                                           | Recovery                                                                                                                                                                                                                                           | Data                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `docker compose restart` of postgres, rustfs, media-worker, backend, web, one at a time | Brief errors only                                                                                                                                                        | Serving again ≤ 1.1 s after each restart                                                                                                                                                                                                           | Dataset intact                           |
| Backend SIGKILL during a 160 MiB upload, at 64 MiB                                      | Upload fails immediately with declared `service.unavailable`, which the SDK did not retry. Its separate transport-only retry budget was also short (250 ms, then 500 ms) | A user **Retry** resumed from the 64 MiB checkpoint and completed                                                                                                                                                                                  | Upload intact; dataset intact            |
| Backend SIGKILL during a 120 MiB download, at 44 MiB                                    | Stream fails with `ECONNRESET`; never a silently short file                                                                                                              | Downloading again succeeds                                                                                                                                                                                                                         | Intact                                   |
| RustFS stopped 20 s under load                                                          | Uploads fail with `service.unavailable`, `Upload part failed (503)` or a **gateway 502** (see below). Downloads fail with `ECONNRESET`                                   | 501 operations succeeded after it returned; the backend never restarted                                                                                                                                                                            | 230/230 acknowledged files intact        |
| PostgreSQL stopped 20 s under load                                                      | Uploads fail with `service.unavailable`; requests stall up to the 10 s pool timeout first                                                                                | 536 operations succeeded after it returned; no backend restart                                                                                                                                                                                     | 234/234 acknowledged files intact        |
| Storage volume full (600 MiB loop device)                                               | Uploads fail with `service.unavailable` or a gateway 502. **Nothing says storage is full, and nothing is logged**                                                        | Emptying Trash released the quota at once, but RustFS kept the deleted bytes in `.rustfs.sys/tmp/.trash` (378 MiB) and the disk stayed 100% full for at least 3 minutes. **Restarting RustFS purged it** (532 → 160 MiB used), then uploads worked | Every committed file intact              |
| Two backend replicas (`--scale backend=2`)                                              | Both started together; migrations ran under an advisory lock. The web host spread connections over both (929 MB and 316 MB of traffic)                                   | —                                                                                                                                                                                                                                                  | 710 operations, 0 failed; 225/225 intact |

The gateway 502 was caused by an earlier rejected upload, not by the RPC waiting for storage. An early PUT rejection cancels an unfinished Node request body. The gateway reused that connection for the next RPC, but Node never parsed that RPC and destroyed the connection on its 6-second socket timeout. The Node proxy now sends `Connection: close` for rejected PUTs on its gateway hop, preventing reuse. It still streams successful transfers. The SDK also maps a 502, 503 or 504 with no RPC envelope to `service.unavailable`; other malformed envelopes remain protocol errors, and valid declared RPC errors are preserved.

Uploads now make up to three automatic retries after 1, 2 and 4 seconds for idempotent status/part requests, including declared `service.unavailable` as well as transport failures. Every attempt retains the upload ID, part number and bounded byte slice. Permanent refusals and cancellation do not retry. Begin and completion replay only an explicit pre-write `uploads.busy` refusal, never an ambiguous outage or lost response: an ambiguous begin must not allocate another upload automatically. A persistent outage still exhausts the budget and leaves the checkpoint for explicit Retry.

Both the checkpoint-boundary and actively leased part crash drills now complete automatically with intact SHA-256. The latter takes about three minutes: a dead writer's unchanged lease remains in PostgreSQL, and the SDK waits on `uploads.busy` for up to 195 seconds. The small part-capability RPC checks admission and the lease before the client sends bytes, because an early binary rejection can lose its envelope through Node's body cancellation. The PUT still authorizes and claims atomically; a capability is not a reservation. No lease is renewed or cleared at startup.

A stale storage write remains a known defect, including with the unchanged three-minute lease. A two-replica drill paused writer A after issuing its storage PUT, waited 181 seconds without changing the lease, then let B acknowledge different same-length bytes. Releasing A's delayed request overwrote B's remote part. There was one database acknowledgement, but completion failed with S3 `InvalidPart` (HTTP 400, mapped to `service.unavailable`). No file was published; the upload stayed `finalizing` with its reservation held. Replaying the part or using SDK Retry did not repair it; Cancel released the reservation. Repeating the original accelerated fixture with identical bytes produced equal RustFS ETags and completed intact. The database token fences acknowledgement and stored ETags fence completion, not an already-issued S3 write. Short renewable leases were withdrawn; stale-part repair is a follow-up, not implemented here.

Ambiguous begin/completion crashes still surface a failed upload rather than being automatically replayed. A lost begin has no local checkpoint; its retained `starting` intent appears in the account's pending list and can be canceled. An explicit Retry starts a new intent. A lost completion retains its checkpoint; explicit Retry uses that upload ID, waits out the lease if necessary, and reconciles the already-completed object instead of publishing duplicate bytes.

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

Watch the disk that holds the `rust-storage-data` volume yourself; there is no free-space metric or alert. A failed upload now logs `storage operation failed` in the backend, including the storage operation and its safe HTTP status/S3 error code. The client still receives only `service.unavailable`. To recover:

1. Free space by deleting data in the product: empty Trash, or delete versions.
2. Restart RustFS with `docker compose --env-file .env.deployment restart rustfs`. RustFS 1.0.0-alpha.85 keeps deleted objects in `.rustfs.sys/tmp/.trash` until it restarts.
3. Check that uploads work again.

## Upload admission

Each backend admits sixteen concurrent upload operations. Within those slots, one authenticated
account (across all its sessions) or anonymous visitor grant set may hold two. Each applicable
public contributor/editor link may hold four across all visitors. The SDK queues two files and
sends their parts serially; the link budget allows two such queues. Begin, part and complete
share these limits. Each account/link has a FIFO queue of at most twice its allowance, waiting
at most 130 seconds, with no database transaction or global upload slot held while waiting.
Server-bound editor saves have independent two/four allowances, still inside the same sixteen
global slots, so background uploads do not consume that person's editor allowance.
Queue overflow, queue timeout or global saturation gets HTTP 409 `uploads.busy`. The SDK waits
five seconds between attempts, for at most 195 seconds or 39 additional attempts after its first
busy answer, then retains its checkpoint for explicit Retry. This also applies to begin and completion only
when the server explicitly refused with `uploads.busy`; ambiguous begin/completion failures
are never replayed automatically. A queued request's in-flight time is additional to client
retry delays. These are per-process limits, so replicas multiply capacity.

A separate sixteen-query authorization gate bounds even unknown/anonymous part lookups before
the database pool. Credential-bearing requests may queue there for up to one second (at most
sixteen waiters); credentials still require database validation. Credential-less requests do not
queue. Unknown or unauthorized uploads never consume a global transfer slot. The upload/save
RPC deadline is 270 seconds to include a queue turn and bounded storage work; reading JSON and
all other RPCs retain the original thirty-second overall deadline.

Anonymous request volume can still slow legitimate uploads; rate limiting at the gateway is
outside this reliability change. Before FIFO admission and separating the authorization gate,
waiting clients polled rather than receiving first-come admission. One run per identity on a
shared two-CPU orb, with 500 concurrent anonymous unknown-ID PUT
workers and a six-part 41,943,043-byte SDK upload, completed intact in 343.782 seconds for an
account (quiet: 1.546 seconds) and 244.769 seconds for a contributor (quiet: 0.367 seconds).
The original `6b08373` backend failed the same runs after 11.786 and 8.123 seconds respectively.
These are single-run failure-drill observations, not deployment performance targets.

After adding FIFO turns, a gateway SDK run with two 167,772,163-byte files (twenty full
8-MiB parts plus three bytes each, about twelve seconds per full part) let another device's
small upload finish in 8.508 seconds while both large files continued. A third contributor
visitor finished in 8.068 seconds while four such files continued on the same link. Both
observed zero busy responses. A same-account SDK editor replace save took 155 ms during those
uploads versus 151 ms quiet, with zero busy responses. All six large-file readbacks across
these runs matched their source SHA-256. These were single runs through the built web host
and Caddy on the shared two-CPU orb, with synthetic editor inventory, not real vendor UI.
They do not establish latency under a simultaneous anonymous flood or cluster-wide fairness.

A part body that supplies no chunk for thirty seconds is abandoned. The storage operation has
a 120-second deadline and the leased worker a 125-second deadline, so sending occasional tiny
chunks cannot hold admission forever. Admission remains owned by the worker across a caller
disconnect until that worker exits; inactive principal-map entries are removed.

An 8-MiB part therefore needs sustained uplink above approximately 0.56 Mbit/s of payload
(8 MiB in 120 seconds), plus headroom for network/storage overhead; part writes use the full
120-second response bound while other storage operations retain their thirty-second bound.
Part writes use the product's thirty-second incoming idle rule instead of the storage SDK's
five-second stream-stall guard; other operations keep their SDK stream protection.

## Missing for production

- **Alert delivery.** The backend exposes private `/metrics`. The optional [monitoring overlay](monitoring.md) collects request, transfer, pool and media-job metrics and evaluates alert rules. Configure and test an operator-owned receiver; a firing rule alone does not page anyone.
- **Diagnosable startup errors.** Storage and database misconfigurations log one indistinguishable line (see the table above).
- **Storage health.** Web readiness follows backend/database readiness. Storage health remains a separate RustFS signal so metadata-only operations can keep working during a storage outage. Media worker health checks socket existence, not decoder progress.
- **Log shipping.** Logs stay in Docker's json-file driver. This review added rotation (10 MB × 5 per container).
- **Disk space.** The monitoring overlay alerts on low available bytes and inodes on the PostgreSQL and RustFS volumes. RustFS alpha.85 can retain deleted bytes until restart, so use filesystem free space rather than released user quota to judge recovery.
- **RustFS maturity.** The object store is an alpha (`1.0.0-alpha.85`).
- **Backup shipping.** Scheduled, retained backups have a health failure signal (see [backup and restore](backup-restore.md)), but encryption, off-host copies and routing health alerts to an operator are not configured by the stack.
- **Users.** The backend, media worker and RustFS run as UID 10001 and the web host as `node`. PostgreSQL's entrypoint starts as root and drops to `postgres`. The init containers run as root with every capability dropped except `CHOWN`/`FOWNER`.
- **Image pinning.** This review pinned every Compose image and web build base by digest. The Rust Dockerfiles were already pinned. The media worker's FFmpeg comes from Debian's archive at a pinned package version, which is reproducible only while Debian keeps that version.

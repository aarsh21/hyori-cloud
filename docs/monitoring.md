# Monitoring a self-hosted instance

Monitoring is opt-in and does not change upload admission, quotas, storage retention, or public API contracts.

```sh
docker compose --env-file .env.deployment -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

The overlay adds Prometheus and a filesystem-only node-exporter. Neither publishes a host port. Prometheus scrapes `backend:3002/metrics` and `volume-exporter:9100/metrics` over the private Compose network every 15 seconds, evaluates alerts every 15 seconds, and retains at most 15 days / approximately 1 GB of samples. The backend port remains unpublished. The web host forwards only the product RPC/storage routes, not `/metrics`. Keep the backend, exporter, Prometheus, and the Compose network private; these endpoints have **no authentication**. Do not add a public reverse-proxy route to them. Use a private network/tunnel for the Prometheus UI.

**Notification delivery is not included.** Rules show firing alerts in Prometheus. Configure an operator-owned Alertmanager and its email/pager/webhook receivers in `monitoring/prometheus.yml` to send notifications, and test that delivery separately. Also monitor Prometheus itself from outside this stack. A stopped monitoring stack cannot alert about itself.

## Request logs and metrics

The Rust backend selects its log format at startup from `APP_ENV`:

- **`development`:** One short line per request, for example `POST files.list 401 client_error 7ms error=auth.required request_id=…` (the actual line includes the full ID). The status and outcome are colored when stdout is a terminal; redirected output is plain text. Set `NO_COLOR=1` to turn color off in a terminal. `-` means the request ended before headers and had no HTTP status. The error is omitted when there is no product error code. Other diagnostics use compact text.
- **`production`** (the Compose default): One JSON object per event with the full context. `docker compose logs --no-log-prefix backend` shows the raw lines.

Both formats render the same INFO summary per request handled by Axum, including rejected and unknown routes. In JSON, look for `target: "hyori_server::request"` and `fields.event: "http.request.completed"`. The envelope has `timestamp`, `level` and `target`; the request details are under `fields`:

- `method`, `operation`: standard HTTP method (or `OTHER`) and registered RPC operation or fixed storage route kind. Malformed/unknown RPCs become `rpc.invalid` / `rpc.unknown`, never the submitted operation string.
- `completion`: `response_headers` when the handler produces headers, or `before_headers` if the request future is dropped before then. Only the former has an HTTP `status` and contributes to the request counter and histogram.
- `status`, `error_code`: HTTP status when one exists and product error code, or `none` where there is no product error (including framework rejections).
- `outcome`: `client_error` for HTTP 4xx, `server_error` for 5xx or a panic before headers, `cancelled` when otherwise dropped before headers, `success` for other responses. A 5xx can be an admission refusal, not an outage.
- `duration_seconds`: arrival to headers or cancellation, including admission/body receipt and sign-in answer delays. Download body streaming is **not** included. Use the in-flight transfer gauge to see bodies that remain active.
- `request_id`: server-generated opaque ID, also returned as `x-request-id` when there is a response. An incoming ID is stripped by the web proxy and never trusted or logged by either service.
- `client_address`: the existing `trusted_proxies` resolution, or `unknown`. Configure both proxy hops as described in operations guidance; an arbitrary forwarded header cannot name a client.
- `service`, `version`, `environment`: the Rust package name and version, and the backend's `APP_ENV` mode.
- `commit_hash`, `region`, `instance_id`: build revision and deployment labels. Set `HYORI_LOG_REGION` and optionally `HYORI_LOG_INSTANCE_ID` in `.env.deployment`. Instance ID defaults to `HOSTNAME` when present. Missing values are `unknown`. Use non-secret labels only.

To record the revision when building the backend from a clean checkout:

```sh
docker compose --env-file .env.deployment build --build-arg HYORI_BUILD_COMMIT="$(git rev-parse HEAD)" backend
```

No URI, query string, credential header, request/response body, file/folder name, email, share token, or arbitrary error message is included in the request event. IP addresses are personal data: restrict log access and choose appropriate retention. Keep `hyori_server=info` (the default) enabled to retain these events. Debug logging of third-party dependencies is not covered by the request-log privacy contract. Route logs through the operator's existing container logging/rotation/shipping policy.

**Uploads and editor saves** add `transfer_kind` (new file, replacement, or editor save), `transfer_replay` when a durable record reveals whether work is reused, the attempted `editor_intent` and `editor_save_mode` on preparation, and `refused_admission` when an upload lane rejects work. A request-time database or storage failure in these operations adds the first failure's category and, when available, a validated SQLSTATE or an owned storage operation and HTTP status. No SQL, vendor error body, account ID, file ID, or editor session/save ID is included. A detached worker that fails after the summary, or a storage response stream that fails, still logs a separate diagnostic with the same `request_id`.

**Web correlation:** Join `web_request.request_id` to the Rust summary's `fields.request_id` when `request_id_source` is `backend`. Only direct product API responses with a backend-issued ID use that source. A rejected proxy request, a drop before upstream headers are available, or an SSR page (which can make multiple backend calls) gets a web-local ID instead. The web summary distinguishes `response_finished` from `connection_closed` (`status: 499`), and `headers_sent` distinguishes a mid-stream drop from an early one. A Rust `response_headers` summary with status 200 and a web `connection_closed` summary can describe the same request; neither is proof that the client received the full file.

Metric names and semantics:

| Metric                                                                          | What it tells you                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hyori_ready`                                                                   | 1 when a cheap `SELECT 1` succeeds within 500 ms, including pool acquisition; otherwise 0. The scrape remains HTTP 200 with process-local metrics. A failed media count cannot change readiness. Like the existing readiness endpoint, this is not a storage health probe.                                                              |
| `hyori_requests_total{operation,status_class}`                                  | Requests by server-owned operation and bounded status class (`2xx` etc.). Includes health/scrapes; example error-rate alert excludes them.                                                                                                                                                                                              |
| `hyori_request_duration_seconds{operation,status_class}`                        | Cumulative histogram of the same arrival-to-headers duration, with buckets through 150 seconds and `+Inf`.                                                                                                                                                                                                                              |
| `hyori_admission_wait_seconds{lane,outcome}`                                    | Histogram of admission attempts, including immediate ones; lanes are `rpc`, `sign_in`, `upload`, `upload_authorization`. RPC is a non-queuing gate. Sign-in measures the verification lane wait, not scrypt time or the fixed answer delay. Upload measures account/link plus global admission, separately from its authorization gate. |
| `hyori_busy_refusals_total{lane}`                                               | Refused/expired admission attempts, not all 503s or all 429s. Busy uploads are HTTP 409; do not infer capacity from HTTP 5xx alone. Cancellation before an admission attempt finishes is not counted as a refusal.                                                                                                                      |
| `hyori_transfers_in_flight{kind}`                                               | Held global download/upload permits. Download permits live until the streaming task ends; upload includes begin/part/complete work, not just body copying.                                                                                                                                                                              |
| `hyori_database_pool_connections{state}`, `hyori_database_pool_max_connections` | Used/idle connections and configured ceiling. These are instantaneous samples, not a historical maximum.                                                                                                                                                                                                                                |
| `hyori_storage_errors_total`                                                    | Original/preview/editor/account-cleanup storage failures at the error boundary. Includes failed streams, not just full disks. Derivative processing has durable job failure state instead; inspect `hyori_media_jobs` and maintenance logs for those failures.                                                                          |
| `hyori_media_jobs{state}`                                                       | Durable queued, processing, failed, ready and unsupported job counts. Queued includes deferred jobs. Failed counts terminal retry exhaustion; unsupported inputs are separate and do not trigger failure alerts.                                                                                                                        |
| `hyori_media_jobs_available`                                                    | 1 when this scrape read all job counts, otherwise 0. On timeout/failure (or database not ready), all `hyori_media_jobs` samples are omitted, never stale or fabricated zeros. `HyoriMediaTelemetryMissing` warns that backlog/failure alerts cannot evaluate.                                                                           |
| `hyori_maintenance_last_success_timestamp_seconds{task}`                        | Last successful pass for auth, uploads, accounts, trash, media, editors. Zero until the first success. A pass can schedule durable retries; a recent timestamp does not mean every pending object has been reclaimed.                                                                                                                   |
| `node_filesystem_*{volume}`                                                     | Actual bytes/inodes of `rust-storage-data` and `rust-postgres-data`, measured by statfs on read-only mounts of those volumes. This is not user quota or a sum of object sizes.                                                                                                                                                          |

All backend label values are bounded by server catalogs. No account, file, item, share, path, client address, or request ID is a metric label. Counters and latency histograms reset with the backend process; Prometheus `rate`/`increase` handle resets. Job counts survive restarts because they come from PostgreSQL. Scrapes do not consume RPC admission and always return process-local metrics when the process can answer. Readiness has its own 500 ms deadline; only after readiness succeeds does the optional media count get a separate two-second deadline, including pool acquisition, with PostgreSQL statement/lock limits of 1,500/500 ms. Both use the existing application pool. Worst-case database waiting is therefore about 2.5 seconds per scrape; a failed readiness check skips the count.

The lead measured the `GROUP BY state` query on **1,000,000 media jobs, a 270 MB table, PostgreSQL 17 with the migration 6 schema/indexes, and this two-CPU orb: 122–254 ms warm**. This is the lead's measurement, not a new benchmark. Several million jobs or a cold cache can exceed the 1,500 ms statement limit. Counts are then omitted and `hyori_media_jobs_available` becomes 0 without hiding process metrics or changing a successful readiness check to 0. Watch `HyoriMediaTelemetryMissing`; changing scrape frequency alone cannot fix a query that exceeds its per-query budget. This change adds no migration or index and does not claim the aggregate has constant cost.

Example latency query:

```promql
histogram_quantile(0.95, sum by (le, operation) (rate(hyori_request_duration_seconds_bucket{operation="files.list"}[5m])))
```

## Data-volume capacity

The exporter mounts **only the two existing data volumes, read-only**. It needs no database/storage credentials, Docker socket, host root mount, privilege, or host PID namespace. Its filesystem collector is restricted to `/volumes/storage` and `/volumes/postgres`; Prometheus maps those fixed mount points to volume names. On ordinary Docker local volumes both may reside on the same host filesystem and report the same free space: that is correct, not independent capacity. Put them on separately provisioned filesystems if independent limits are required. Remote volume drivers may report backend-specific capacity; confirm statfs and the missing-telemetry alert for your driver.

Low-space fires at less than 15% available with **no hold period**. Scrape + evaluation can still take about 30 seconds. This is an early-warning signal, not an admission reservation: a burst larger than the remaining capacity can fill a disk between samples. Increase the threshold for large transfers or slow operator response, provision headroom for PostgreSQL WAL/maintenance and object multipart/version/trash bytes, and test notification delivery. The separate low-inode rule covers filesystems that run out of entries before bytes.

RustFS `1.0.0-alpha.85` was observed retaining deleted object bytes until restart. Do not equate application deletion, released quota, or S3 disappearance with returned physical space. Confirm physical available bytes in the exporter. Stop new writes, verify backups and in-flight work, then follow a controlled RustFS restart/recovery procedure if needed; do not delete its internal files or volumes. This overlay does not change or hide that behavior.

## Alerts and operator actions

Thresholds are examples for a small self-hosted instance, not measured capacity guarantees. Tune them for your workload without removing the underlying signals.

### HyoriBackendNotReady

Backend scrape unavailable or the independent database readiness check fails for one minute. Check container health/restarts, startup logs, database reachability and pool saturation. Confirm `/health/ready` on the private network. If Prometheus `up=1` but `hyori_ready=0`, process metrics remain available to diagnose the database/pool incident. An unavailable media count alone does not trigger this alert. Do not restart PostgreSQL blindly or delete data to get a green check.

### HyoriErrorRate

More than 5% product requests are HTTP 5xx, at least five failures in five minutes, sustained for two minutes. Group request counters by operation and correlate request IDs, storage errors, pool use and busy counters. Authorization/input errors are not server outages. Missing successful-request series must not hide real 5xx failures.

### HyoriBusy

More than six refused attempts/minute in a lane over five minutes, sustained five minutes. Check that lane's wait histogram and transfer/pool gauges. Reduce client concurrency or abusive traffic first; inspect slow storage/SQL/KDF work before raising concurrency. A sign-in flood and an upload fairness queue require different responses. Ordinary wrong passwords/rate-limit errors are not automatically busy refusals.

### HyoriStorageErrors

Any observed original/preview/editor/cleanup storage error in five minutes. Check sanitized storage operation/status/code logs, RustFS health, credentials, capacity and network. Failed streams can be client disconnects/timeouts rather than a full volume; correlate before acting. Preserve incomplete-upload inventory and let bounded retry/recovery run. Do not delete object-store internals.

### HyoriVolumeLowSpace

Less than 15% bytes available on either volume. Pause new ingest, inspect actual free bytes and the growth rate, provision capacity, and check retained trash/versions/incomplete uploads plus PostgreSQL WAL. Only remove data through documented application/retention/backup procedures. Low inodes has the same response, but capacity expansion must include inode capacity. Restarting a database is not a disk-space recovery strategy.

### HyoriVolumeTelemetryMissing

Exporter down, a required volume series absent, or statfs reports an error, for one minute. Check mounts, exporter logs, volume-driver support and scrape connectivity. Do not treat a missing series as free disk. Verify both named volumes are mounted, even when they share one filesystem.

### HyoriMaintenanceStale

One task has no successful pass for five minutes, sustained two minutes. Zero also covers a task that never ran after startup. Inspect its task label and backend maintenance logs, database locks/pool, storage outages and worker socket. Do not manually purge records or objects while their durable lease/recovery owner is active.

### HyoriMediaBacklog

More than 100 queued jobs for ten minutes. Check that maintenance advances, the private media-worker socket/health, process memory/CPU limits, unsupported input counts and storage availability. Compare processing/failed counts and actual throughput before changing worker concurrency. Originals remain independent of derivative generation.

### HyoriMediaTelemetryMissing

The latest scrape could not read media counts. This alert has no hold period: backlog and failure rules cannot evaluate while their samples are omitted, and their pending timers may reset. Check `hyori_ready` first for a database/pool outage. If readiness is 1, inspect locks on `hyori_media_jobs`, database load and the count query's duration/statement timeout. Restore count availability before treating a missing backlog/failure alert as healthy; do not replace missing counts with zeros. Process-local request, admission, storage, transfer and pool metrics remain available.

### HyoriMediaFailures

Terminally failed jobs remain for five minutes. Inspect worker/maintenance logs and failure inventory; correct unavailable storage/worker/resource issues and use supported product retry/rebuild operations. Unsupported formats are not counted as exhausted-retry failures. Do not remove originals to silence this alert.

## Validate configuration

```sh
docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v3.8.0 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v3.8.0 check rules /etc/prometheus/alerts.yml
```

The HTTP/privacy regression runs with isolated PostgreSQL and RustFS fixtures:

```sh
RUST_ICU_MAJOR_VERSION_NUMBER="$(pkg-config --modversion icu-uc | cut -d. -f1)" cargo test --locked -p hyori-server --test observability -- --ignored --test-threads=1
```

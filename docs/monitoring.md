# Monitoring a self-hosted instance

Monitoring is opt-in and does not change upload admission, quotas, storage retention, or public API contracts.

```sh
docker compose --env-file .env.deployment -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

The overlay adds Prometheus and a filesystem-only node-exporter. Neither publishes a host port. Prometheus scrapes `backend:3002/metrics` and `volume-exporter:9100/metrics` over the private Compose network every 15 seconds, evaluates alerts every 15 seconds, and retains at most 15 days / approximately 1 GB of samples. The backend port remains unpublished. The web host forwards only the product RPC/storage routes, not `/metrics`. Keep the backend, exporter, Prometheus, and the Compose network private; these endpoints have **no authentication**. Do not add a public reverse-proxy route to them. Use a private network/tunnel for the Prometheus UI.

**Notification delivery is not included.** Rules show firing alerts in Prometheus. Configure an operator-owned Alertmanager and its email/pager/webhook receivers in `monitoring/prometheus.yml` to send notifications, and test that delivery separately. Also monitor Prometheus itself from outside this stack. A stopped monitoring stack cannot alert about itself.

## Request logs and metrics

The backend emits one `hyori_server::request` info event when a request produces response headers, including rejected and unknown routes:

- `operation`: registered RPC operation or fixed storage route kind; malformed/unknown RPCs become `rpc.invalid` / `rpc.unknown`, never the submitted operation string.
- `status`, `error_code`: HTTP status and product error code, or `none` where there is no product error (including framework rejections).
- `duration_seconds`: arrival to headers, including admission/body receipt and sign-in answer delays. Download body streaming is **not** included; use the in-flight transfer gauge to see bodies that remain active. A client disconnect after headers does not turn a logged 200 into proof of successful delivery.
- `request_id`: newly generated opaque ID, also returned as `x-request-id`; an incoming ID is never trusted or logged.
- `client_address`: the existing `trusted_proxies` resolution, or `unknown`. Configure both proxy hops as described in operations guidance; an arbitrary forwarded header cannot name a client.

No URI, query string, credential header, request/response body, file/folder name, email, share token, or arbitrary error message is included in the request event. IP addresses are personal data: restrict log access and choose appropriate retention. Keep `hyori_server=info` (the default) enabled to retain these events. Debug logging of third-party dependencies is not covered by the request-log privacy contract. Route logs through the operator's existing container logging/rotation/shipping policy.

Metric names and semantics:

| Metric                                                                          | What it tells you                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hyori_ready`                                                                   | 1 when the scrape can query PostgreSQL. A failed/timed-out query gives HTTP 503 and Prometheus `up=0`, not a stale healthy response. Like the existing readiness endpoint, this is not a storage health probe.                                                                                                                          |
| `hyori_requests_total{operation,status_class}`                                  | Requests by server-owned operation and bounded status class (`2xx` etc.). Includes health/scrapes; example error-rate alert excludes them.                                                                                                                                                                                              |
| `hyori_request_duration_seconds{operation,status_class}`                        | Cumulative histogram of the same arrival-to-headers duration, with buckets through 150 seconds and `+Inf`.                                                                                                                                                                                                                              |
| `hyori_admission_wait_seconds{lane,outcome}`                                    | Histogram of admission attempts, including immediate ones; lanes are `rpc`, `sign_in`, `upload`, `upload_authorization`. RPC is a non-queuing gate. Sign-in measures the verification lane wait, not scrypt time or the fixed answer delay. Upload measures account/link plus global admission, separately from its authorization gate. |
| `hyori_busy_refusals_total{lane}`                                               | Refused/expired admission attempts, not all 503s or all 429s. Busy uploads are HTTP 409; do not infer capacity from HTTP 5xx alone. Cancellation before an admission attempt finishes is not counted as a refusal.                                                                                                                      |
| `hyori_transfers_in_flight{kind}`                                               | Held global download/upload permits. Download permits live until the streaming task ends; upload includes begin/part/complete work, not just body copying.                                                                                                                                                                              |
| `hyori_database_pool_connections{state}`, `hyori_database_pool_max_connections` | Used/idle connections and configured ceiling. These are instantaneous samples, not a historical maximum.                                                                                                                                                                                                                                |
| `hyori_storage_errors_total`                                                    | Original/preview/editor/account-cleanup storage failures at the error boundary. Includes failed streams, not just full disks. Derivative processing has durable job failure state instead; inspect `hyori_media_jobs` and maintenance logs for those failures.                                                                          |
| `hyori_media_jobs{state}`                                                       | Durable queued, processing, failed, ready and unsupported job counts. Queued includes deferred jobs. Failed counts terminal retry exhaustion; unsupported inputs are separate and do not trigger failure alerts.                                                                                                                        |
| `hyori_maintenance_last_success_timestamp_seconds{task}`                        | Last successful pass for auth, uploads, accounts, trash, media, editors. Zero until the first success. A pass can schedule durable retries; a recent timestamp does not mean every pending object has been reclaimed.                                                                                                                   |
| `node_filesystem_*{volume}`                                                     | Actual bytes/inodes of `rust-storage-data` and `rust-postgres-data`, measured by statfs on read-only mounts of those volumes. This is not user quota or a sum of object sizes.                                                                                                                                                          |

All backend label values are bounded by server catalogs. No account, file, item, share, path, client address, or request ID is a metric label. Counters and latency histograms reset with the backend process; Prometheus `rate`/`increase` handle resets. Job counts survive restarts because they come from PostgreSQL. Scrapes have a two-second database deadline and do not consume RPC admission. Large media tables can make the aggregate query expensive: monitor scrape duration and `up`, and adjust scrape frequency or the query/index design based on measured scale rather than silently serving stale counts.

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

Backend scrape/readiness unavailable for one minute. Check container health/restarts, startup logs, database reachability and pool saturation. Confirm `/health/ready` on the private network. A failing metrics query also makes this fire; check scrape errors before blaming the public gateway. Do not restart PostgreSQL blindly or delete data to get a green check.

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

### HyoriMediaFailures

Terminally failed jobs remain for five minutes. Inspect worker/maintenance logs and failure inventory; correct unavailable storage/worker/resource issues and use supported product retry/rebuild operations. Unsupported formats are not counted as exhausted-retry failures. Do not remove originals to silence this alert.

## Validate configuration

```sh
docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v3.8.0 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v3.8.0 check rules /etc/prometheus/alerts.yml
```

The HTTP/privacy regression runs with an isolated PostgreSQL fixture:

```sh
RUST_ICU_MAJOR_VERSION_NUMBER="$(pkg-config --modversion icu-uc | cut -d. -f1)" cargo test --locked -p hyori-server --test observability -- --ignored --test-threads=1
```

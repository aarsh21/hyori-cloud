# Hyori isolated media worker

This executable is the only Hyori process that launches media decoders. The application backend streams an immutable original over a private Unix socket; the worker returns a small normalized WebP. The injected Unix HTTP adapter lives at the app composition boundary in `apps/server/src/media_worker.rs`, not inside a domain feature or browser graph. It receives **no PostgreSQL, RustFS/S3, session or authentication credentials**, has no network interface except loopback, and never accepts a URL, filename, command or argument list from a caller.

## Protective budgets, not performance claims

These limits were chosen before implementation. They are not measured throughput, NAS sizing, browser fidelity or supported-library-capacity promises.

| Boundary                      | Limit                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| Concurrent worker requests    | 1; excess requests fail `busy`                                             |
| Source bytes                  | 1–64 MiB, exact Content-Length, streamed to private scratch                |
| Input idle / entire request   | 10 seconds / 60 seconds                                                    |
| Probe / encode subprocess     | 10 seconds / 20 seconds, killed on cancellation/drop                       |
| Source pixels                 | 40,000,000; probe dimensions checked before encoding                       |
| Video duration                | finite, positive and at most 120 seconds                                   |
| Normalized output             | Single-frame lossy WebP, quality 75, each dimension 1–384, at most 256 KiB |
| Probe stdout / decoder stderr | 64 KiB / 8 KiB; overflow kills work                                        |
| Decoder individual allocation | 64 MiB (`-max_alloc`), not a total-memory substitute                       |
| Decoder/filter threads        | 1 each; worker Tokio runtime is current-thread                             |
| Required container envelope   | ≤1 CPU, ≤512 MiB memory, ≤64 PIDs, ≤96 MiB noexec/nosuid tmpfs             |

The enforced cgroup limit is the total-memory boundary, including cases where probing itself needs decoder work. An OOM or process loss produces a failed/unavailable job and consumes the backend's bounded attempt budget; it is not a successful thumbnail. The original remains downloadable. Cancellation while receiving input is tested to clean scratch. After the full input arrives, a disconnected caller may leave the bounded decode finishing; subprocess/request deadlines still apply, and account purge waits for active processing leases rather than claiming immediate recall of bytes.

JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and QuickTime are accepted only with matching bounded headers and an explicit selected demuxer. FFprobe/FFmpeg receive an explicit format whitelist and `file,pipe` protocol whitelist. MOV external data references and absolute reference paths are disabled. The only input argument is the fixed `source` file in a newly created random scratch directory. Commands use absolute installed executable paths, `env_clear`, no shell, null stdin, capped pipes and `kill_on_drop`.

Images use the first frame; video posters use the first video frame, not a scene-selection algorithm. The encoder uses a 244px long edge, preserving aspect ratio and never enlarging a smaller original; the validation/schema safety ceiling is 384px. The measured square phone tile is 122 CSS pixels at DPR 2. Desktop tiles measure 167.344 CSS pixels: a 336px candidate supplies their DPR 2 long edge, but missed the five-second cold phone target on real photographs, so the single stored size favors phone bytes over desktop Retina sharpness. Separate responsive derivatives are not implemented. FFmpeg autorotation is enabled, metadata/chapter maps are removed and frame side data is deleted. A real EXIF orientation-6 rectangular fixture produces portrait output. Both ends check the complete RIFF envelope and exactly one lossy VP8 key frame, partition bounds, signature and unscaled dimensions. Extended/lossless/animated WebP, additional chunks, metadata and trailing data are rejected without decoding in the server. Output is YUV420 (no alpha). This does **not** establish color-profile, HDR, alpha, animation, document or browser codec fidelity; formats/variants that cannot be safely probed within the bounds fail honestly.

## Required deployment boundary

Build locally; this task does not publish an image:

```sh
docker build -f apps/media-worker/Dockerfile -t hyori-media-worker:local .
```

The worker performs Linux runtime checks before binding its socket: nonroot effective UID, zero effective capabilities, `NoNewPrivs=1`, seccomp filtering, read-only root, no non-loopback interface, bounded cgroup-v2 memory/CPU/PIDs, and bounded noexec/nosuid scratch tmpfs. Only PATH, HOSTNAME, HOME, HYORI_MEDIA_SOCKET, LANG, LC_ALL and TZ environment names are accepted. Missing isolation or unexpected environment makes startup fail closed. There is no unsandboxed fallback or disable-check flag.

The parent deployment owner should integrate an equivalent configuration; this is a contract/example, not an edit to root Compose:

```yaml
services:
  media-worker:
    image: hyori-media-worker:local # pin the verified digest for deployment
    user: "10001:10001"
    init: true
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    cpus: 1
    mem_limit: 512m
    memswap_limit: 512m
    pids_limit: 64
    tmpfs:
      - /scratch:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700
    volumes:
      - media_socket:/run/hyori-media
    environment:
      HYORI_MEDIA_SOCKET: /run/hyori-media/worker.sock
    restart: on-failure
  backend:
    environment:
      HYORI_MEDIA_WORKER_SOCKET: /run/hyori-media/worker.sock
    volumes:
      - media_socket:/run/hyori-media:ro
volumes:
  media_socket:
```

Initialize **only the new dedicated socket volume** with owner `10001:10001` and mode `0700` or `0770`; do not mount user files, the Docker socket, databases, storage credentials or another service's sockets. The worker creates a mode-0660 socket. The backend's read-only mount can connect to the Unix socket without modifying the volume. Both configured paths must be absolute and fit the Unix socket length limit. The backend socket is operator-owned configuration, never an RPC parameter.

Linux with cgroup v2 and Docker seccomp/capability controls is the currently verified runtime. Rootless/NAS deployments that cannot establish these bounds must report the failure rather than weaken it. This is a container boundary sharing the host kernel, not a VM or a complete sandbox/security audit. The Debian FFmpeg binary contains more codecs/protocols than this service permits; whitelists, private scratch, no credentials and OS isolation remain necessary together.

Omitting `HYORI_MEDIA_WORKER_SOCKET` disables new processing. Original uploads/downloads continue, `media.get` reports `unavailable` for nonready work, and existing authorized ready artifacts can still be read. A configured but unavailable worker produces bounded queued retries and then an explicit failed state.

## Private protocol and public contract

The executable/library owns protocol constants in `src/lib.rs`. `POST /v1/derive` over the private Unix socket carries raw original bytes, exact Content-Length and `x-hyori-media-type` from server-owned file metadata. It returns bounded `image/webp` bytes and dimension headers, or a typed JSON `{error}` code: unsupported, invalidMedia, resourceLimit, timeout, busy or unavailable. The backend also validates normalized 1–256px PNG from an old worker during a rolling upgrade. There is no network listener, user-chosen path, storage endpoint or credential field.

The **product** schemas live in `apps/server/src/features/media/api.rs`, not in a handwritten SDK mirror:

- `media.get({id})` is an authorized safe read.
- `media.retry({id})` is an explicit mutation available to current readers, not file-edit permission.
- `TimelineItem.derivative` is **optional** for compatibility with older backends. When present it is the same discriminated union: unavailable, queued, processing, ready, unsupported or failed. Every variant has `kind: thumbnail | poster` and `sourceRevision`; ready alone has a nonnullable `url`, `width`, `height`; unsupported/failed carry a typed `failure`, and failed has `canRetry`.
- Photos `previewUrl` continues to mean the safe **original**, including video playback. A poster is never substituted for that URL.
- `/api/storage/derivatives/{fileId}/{artifactId}?revision=...` reauthorizes the current original and verifies its current immutable-source association on every GET, before checking its ETag. Responses are normalized WebP or legacy PNG with `private, no-cache`, nosniff/sandbox headers and shared range/admission policy. Authorized matching validators answer 304 without storage access. An old derivative URL cannot read a replaced original's old cache. Original history remains owner-only through the existing APIs.

Files adds an optional `FileList.thumbnails` map beside the unchanged `items`, keyed by item ID.
Each value has a nullable ready `url` and a `pending` flag. The already-authorized page is selected
first; one batched lookup supplies this projection. It serves owned Files, shared items and public
folders through the same currently authorized derivative route, not an owner-scoped Photos call.
Trash keeps its icons. Readers from before this addition can ignore the map. Missing, pending,
failed and binary-error thumbnails retain the existing fixed-size icon slot; image bytes enter a
six-slot shared load queue only near the viewport. Pending listings refresh whole pages, at most
three loaded pages every 15 seconds, never one metadata request per row.

### Upgrading existing thumbnails

Upgrade the backend (migration 20) before replacing the worker. The geometry constraint is relaxed with `NOT VALID`: no table rewrite or existing-row scan; a two-second DDL lock timeout fails startup rather than waiting indefinitely behind another transaction. Existing rows satisfy the old, stricter constraint. New and updated rows are checked immediately.

Recipe 1 is retained deliberately. Existing PNG thumbnails are **not automatically regenerated or deleted**. Legacy server-owned artifact keys have no suffix; newly validated WebP keys end in `_webp` (the storage adapter deliberately forbids dots). That immutable format marker selects the response MIME/filename without reading or decoding the object. Current authorization and ETag policy are unchanged for both.

Migration 22 adds a decoder identity, upgrade-retry marker and private failure diagnostic. The
worker's private `GET /v1/decoder` reports a deterministic SHA-256 of the decoder's Rust tokens
(arguments, validation and limits), actual installed FFprobe/FFmpeg executables and their linked
shared-library bytes. Comments, formatting, unrelated server/UI/protocol code, package-ledger
entries, timestamps and image IDs do not participate. Decoder source/argument changes enter the
identity automatically at compilation through `build.rs`; there is no manual recipe bump to forget.
This includes the request's bounded streaming/header-validation function, not socket startup.
`cargo check -p hyori-media-worker` fails if `decode.rs` gains an unregistered child module;
extracted decoder implementation must enter the identity inputs rather than silently escape them.
An identified POST carries `x-hyori-decoder`; a worker replaced between lookup and POST rejects an
identity mismatch before decoding. An old worker with no identity can process ordinary work but
cannot trigger automatic terminal recovery.

The existing bounded 256-item discovery sweep requeues `failed` (including exhausted retryable
failures) and `unsupported` jobs whose last decoder differs. Each gets exactly one automatic
attempt for that decoder; another failure is terminal until the decoder changes again or a reader
explicitly retries an eligible failed job. Ready artifacts are untouched. Restarting either process
with identical inputs does not reset attempts. Upgrade work is lower priority than ordinary due
jobs, uses the same one-at-a-time claim/worker semaphore, and does not create a parallel queue
processor. A successful upgrade clears its low-priority marker so later cache repair remains
ordinary work. A rollback to different decoder inputs is another decoder change.

Decoder rejections persist `failure_detail` as allowlisted `{stage, reason}` values in
`hyori_media_jobs` and an operator warning correlated by job ID. Probe and encode failures are
distinct; deadlines, limits, invalid probe/output, missing visual/duration and a small stderr-phrase
allowlist have bounded reasons. Raw stderr, paths, embedded metadata and source bytes are never
persisted or returned. Storage/transport failures and old workers can have no decoder detail;
the existing typed `failure` still identifies that category. Product RPCs expose none of this
operator diagnostic. Operators can inspect it with a read-only database query:

```sql
SELECT id, state, attempts, decoder_revision, upgrade_retry, failure, failure_detail
FROM hyori_media_jobs WHERE state IN ('failed', 'unsupported') ORDER BY due_at LIMIT 100;
```

An operator wanting smaller derivatives can explicitly requeue selected legacy jobs in small batches, after taking a backup and upgrading both processes. This is maintenance SQL, not a browser action or a required upgrade step:

```sql
WITH chosen AS (
    SELECT j.id FROM hyori_media_jobs j
    JOIN hyori_media_artifacts a ON a.id = j.artifact_id
    WHERE j.state = 'ready' AND a.state = 'ready' AND right(a.object_key, 5) <> '_webp'
    ORDER BY j.id LIMIT 100 FOR UPDATE OF j SKIP LOCKED
)
UPDATE hyori_media_jobs SET state = 'queued', attempts = 0, failure = NULL,
    due_at = now(), deferred = false, lease_token = NULL, lease_until = NULL
WHERE id IN (SELECT id FROM chosen);
```

Wait for that batch to settle before repeating. Tiles temporarily show preparing while requeued; originals remain readable. New output publishes under a new immutable key. Old cache objects/intents remain retained until the existing source/account cleanup lifecycle removes them; this operation does not reclaim their storage immediately. No original, upload, quota or version row is changed. Do not reset processing jobs or erase artifact inventory manually.

## Durable processing and storage

`0006_derivatives.sql` stores source-key/recipe jobs and independent exact-key artifact intents. Maintenance discovers at most 32 unprocessed current sources and claims one job per pass, ordered by durable due time with five-minute fenced leases. Queries/refetches do not enqueue jobs, write state or start decoding. Upload commit does not wait for a decoder. Backfill considers current supported media across owned libraries; personal Photos source selection controls visibility, not a separate processing permission or storage import.

There are three automatic attempts with persisted exponential delay and at most six total attempts after explicit retries. Invalid/unsupported/over-budget media is terminal unsupported; an exhausted failed job exposes `canRetry: false`. A crashed processing lease can be reclaimed within that budget. This is bounded lifecycle recovery, not an unbounded polling/reprocessing loop. Hourly retained-key reconciliation checks ready-object length/existence: an observed missing or length-invalid cache enters repair within that same budget, while a storage outage merely postpones verification. A failed derived GET or metadata refetch alone never queues repair. Consequently a metadata-ready cache can still encounter a binary storage error before maintenance observes the loss; consumers must retain their image-error state.

The backend buffers only the ≤256 KiB normalized result. Every derivative S3 begin is preceded by a **committed unique key intent** under `owners/{owner}/derivatives/{id}`. Network/decoder effects never run inside retryable DB callbacks. Publication rechecks the job token, active owner and current immutable source. Ambiguous publication acknowledgements never turn an already-ready artifact into an abort marker. Canonical source-key + recipe records allow restore to reuse a previously ready artifact without decoding/charging again.

Cache artifacts are server-owned/rebuildable and **do not change original used/reserved quota**. Implementation default: ready caches are retained for their immutable source/recipe until account purge; there is no global eviction or per-user cache-quota system in this slice. Overhead is up to 256 KiB per successful immutable source/recipe plus database records and transient multipart work. Failed/abandoned intent records remain indefinitely. Capacity/retention sizing is operational follow-up, not a claimed bound on total instance storage.

Account purge marks derivative intents aborted and redacts job associations, prunes jobs in bounded batches, waits for live worker leases to settle/expire, and requires successful exact-key reconciliation before completing. Committed contributions/cache owned by another account survive. Objects-only owner-prefix sweeps and retained per-key multipart cleanup continue after completion, including late begin/complete effects. RustFS alpha.85's broken multipart owner-prefix enumeration is never treated as proof of absence. Do not add FK cascades that erase this inventory.

## Verification and provenance

The actual worker image was built and exercised with network-none, nonroot identity, read-only root and the bounds above. Four ignored-by-default Rust media tests cover all eight synthetic formats, actual output decoding, orientation/metadata removal, malformed/mismatched/oversized/over-duration input, cancellation scratch cleanup, rejected unisolated startup, lost S3 begin, expired job leases, current replacement/restore, quota, private/share revocation, pending-worker account deletion and late artifact cleanup. The public SDK harness uploads real fixtures, waits on safe product reads, exercises outage/failed retry after restart and preserved contributions. This is not real-browser visual or performance evidence.

```sh
export HYORI_MEDIA_TEST_IMAGE=hyori-media-worker:local
cargo test --locked -p hyori-server --test media -- --ignored --test-threads=1
bun scripts/test-rust-media-sdk.ts
```

The SDK harness builds a uniquely tagged local worker image if that variable is absent, or uses the explicitly supplied image. Fixtures use unique names/random credentials and remove only their own containers/directories. They use the host's nonroot UID for a private temporary socket bind mount; production defaults remain UID/GID 10001.

Verified decoder build on 2026-11-05: Debian FFmpeg **7:7.1.5-0+deb13u1**, libavcodec61/libavformat61/libavutil59/libswscale8 of that same package version, and libdav1d7 **1.5.1-1**. The worker Dockerfile pins the FFmpeg package and base image digests; the complete installed package/version ledger and FFmpeg configure flags are preserved in `/usr/share/hyori-media/{packages.txt,ffmpeg-version.txt}`. Other dependency resolution still follows Debian repositories; an immutable tested image digest, not a mutable tag, identifies the verified artifact.

License/provenance: FFmpeg upstream is <https://ffmpeg.org>. The installed Debian `/usr/share/doc/ffmpeg/copyright` states most source is LGPL-2.1+, Debian's default binary uses GPL parts and is GPL-2+, optional extra library flavors may be effectively GPL-3+, and Debian does not enable the nonfree combination. This image's configure flags include `--enable-gpl`. Preserve `/usr/share/doc/*/copyright`, `/usr/share/common-licenses`, notices and required corresponding source when redistributing the image; the package ledger/URLs alone do not fulfill all distribution obligations. The broader container/library graph has **not** received a complete legal or security audit. No image was publicly pushed. Rust dependency versions remain in the naturally resolved Cargo.lock.

All media inputs in acceptance are locally synthetic CC0 fixtures documented in `apps/server/tests/fixtures/media/README.md`. No product artwork was generated and no user media was sent to Codex or any external service.

`tests/fixtures/video` adds sixteen generated CC0-1.0 two-second clips, including audio ordering,
fragmentation, codecs, odd/tall/4K geometry and a display-matrix rotation. Recreate them with
`bun scripts/generate-media-video-fixtures.ts`; their README records generation and provenance.
The isolated-worker `media_videos` suite independently decodes every WebP and checks the rotated
quadrants as well as portrait dimensions. `media_upgrades` checks the additive listing, exhausted
and unsupported recovery, new-upload priority, preserved ready artifact and same-worker restart.

Upgrade recovery distinguishes a decoder verdict (`unsupported`, `invalidMedia`, `resourceLimit`)
from an infrastructure failure (`unavailable`, `busy`, `timeout`, including an expired lease).
A verdict remains terminal for that fingerprint. Infrastructure failures release the verdict
attempt and stay queued behind new uploads, with durable 20/40/80/160/320/640-second backoff,
capped at 640 seconds until the fault clears. Migration `0023` persists the bounded backoff
counter. Same-fingerprint server/worker restarts neither reset that counter nor advance its due
time; ready artifacts remain untouched. Discovery also repairs the same-fingerprint transient
rows stranded by the earlier upgrade policy. This does not change ordinary initial-job retry
limits. Operators can inspect `state`, `failure`, `failure_detail`, `upgrade_failures`, `due_at`
and `decoder_revision` in `hyori_media_jobs`; no raw subprocess stderr is stored or exposed.

`lead_outage` is the supplied real TCP-relay/RustFS outage regression, with final recovery and
natural-backoff assertions added. `media_recovery` additionally injects Busy/Timeout responses
at the private socket (not a real process deadline), then uses the real isolated decoder for
recovery, checks the backoff cap/restarts/expired leases and verifies new-upload priority.

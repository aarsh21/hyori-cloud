# Hyori isolated media worker

This executable is the only Hyori process that launches media decoders. The application backend streams an immutable original over a private Unix socket; the worker returns a small normalized PNG. The injected Unix HTTP adapter lives at the app composition boundary in `apps/server/src/media_worker.rs`, not inside a domain feature or browser graph. It receives **no PostgreSQL, RustFS/S3, session or authentication credentials**, has no network interface except loopback, and never accepts a URL, filename, command or argument list from a caller.

## Protective budgets, not performance claims

These limits were chosen before implementation. They are not measured throughput, NAS sizing, browser fidelity or supported-library-capacity promises.

| Boundary                      | Limit                                                          |
| ----------------------------- | -------------------------------------------------------------- |
| Concurrent worker requests    | 1; excess requests fail `busy`                                 |
| Source bytes                  | 1–64 MiB, exact Content-Length, streamed to private scratch    |
| Input idle / entire request   | 10 seconds / 60 seconds                                        |
| Probe / encode subprocess     | 10 seconds / 20 seconds, killed on cancellation/drop           |
| Source pixels                 | 40,000,000; probe dimensions checked before encoding           |
| Video duration                | finite, positive and at most 120 seconds                       |
| Normalized output             | 8-bit RGB PNG, each dimension 1–256, at most 256 KiB           |
| Probe stdout / decoder stderr | 64 KiB / 8 KiB; overflow kills work                            |
| Decoder individual allocation | 64 MiB (`-max_alloc`), not a total-memory substitute           |
| Decoder/filter threads        | 1 each; worker Tokio runtime is current-thread                 |
| Required container envelope   | ≤1 CPU, ≤512 MiB memory, ≤64 PIDs, ≤96 MiB noexec/nosuid tmpfs |

The enforced cgroup limit is the total-memory boundary, including cases where probing itself needs decoder work. An OOM or process loss produces a failed/unavailable job and consumes the backend's bounded attempt budget; it is not a successful thumbnail. The original remains downloadable. Cancellation while receiving input is tested to clean scratch. After the full input arrives, a disconnected caller may leave the bounded decode finishing; subprocess/request deadlines still apply, and account purge waits for active processing leases rather than claiming immediate recall of bytes.

JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and QuickTime are accepted only with matching bounded headers and an explicit selected demuxer. FFprobe/FFmpeg receive an explicit format whitelist and `file,pipe` protocol whitelist. MOV external data references and absolute reference paths are disabled. The only input argument is the fixed `source` file in a newly created random scratch directory. Commands use absolute installed executable paths, `env_clear`, no shell, null stdin, capped pipes and `kill_on_drop`.

Images use the first frame; video posters use the first video frame, not a scene-selection algorithm. Scaling never enlarges a smaller original. FFmpeg autorotation is enabled, metadata/chapter maps are removed and frame side data is deleted. A real EXIF orientation-6 rectangular fixture produces portrait output. Only IHDR/pHYs/IDAT/IEND PNG chunks are accepted at both ends; EXIF/text/ICC chunks are not returned. This normalizes/strips metadata but does **not** establish color-profile, HDR, alpha, animation, document or browser codec fidelity. Output is RGB (no alpha); formats/variants that cannot be safely probed within the bounds fail honestly.

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

The executable/library owns protocol constants in `src/lib.rs`. `POST /v1/derive` over the private Unix socket carries raw original bytes, exact Content-Length and `x-hyori-media-type` from server-owned file metadata. It returns bounded `image/png` bytes and dimension headers, or a typed JSON `{error}` code: unsupported, invalidMedia, resourceLimit, timeout, busy or unavailable. There is no network listener, user-chosen path, storage endpoint or credential field.

The **product** schemas live in `apps/server/src/features/media/api.rs`, not in a handwritten SDK mirror:

- `media.get({id})` is an authorized safe read.
- `media.retry({id})` is an explicit mutation available to current readers, not file-edit permission.
- `TimelineItem.derivative` is **optional** for compatibility with older backends. When present it is the same discriminated union: unavailable, queued, processing, ready, unsupported or failed. Every variant has `kind: thumbnail | poster` and `sourceRevision`; ready alone has a nonnullable `url`, `width`, `height`; unsupported/failed carry a typed `failure`, and failed has `canRetry`.
- Photos `previewUrl` continues to mean the safe **original**, including video playback. A poster is never substituted for that URL.
- `/api/storage/derivatives/{fileId}/{artifactId}?revision=...` reauthorizes the current original and verifies its current immutable-source association on every GET. Responses are known normalized PNG with no-store/nosniff/sandbox headers and shared range/admission policy. An old derivative URL cannot read a replaced original's old cache. Original history remains owner-only through the existing APIs.

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

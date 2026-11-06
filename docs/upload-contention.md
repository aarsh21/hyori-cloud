# Upload contention and publication recovery

Status: focused real-service regressions pass on 2026-11-05. Integrated Rust/service gates and a rebuilt release/browser pass are still required. This is correctness evidence, not a capacity or latency benchmark.

## Observed failures

The real Chromium acceptance fixture intermittently received `resource.conflict` during ordinary, uniquely named same-owner uploads with queue concurrency two. Both `uploads.begin` and `uploads.complete` were observed on immutable server image `sha256:129ecc24c5b42b16c2c22469feb7cc3378cd6540a043888eb0990728e91c8fb6`. The traffic recorder did not retain those response bodies; the code was inferred from the UI result and known envelope. These observations are separate from the fixture's deliberate, valid concurrent-version conflict.

The parent then added `apps/server/tests/upload_contention.rs`, using the actual HTTP API, disposable PostgreSQL 17 and pinned RustFS `1.0.0-alpha.85`:

- Two concurrent workflows each uploaded twelve unique three-byte files. The initial implementation produced a recorded PostgreSQL deadlock, failing the zero-deadlock assertion even when transaction retries recovered every request.
- Changing only row-lock strengths removed deadlocks but still produced `40001` retries and exhausted reservation attempts. Safe SQLSTATE/phase tracing confirmed this, rather than inferring it from request duration. Bounded exponential jitter alone did not fix the workload.
- Forcing `40001` on the final item insert after S3 completion reproduced a retained finalization lease and a misleading `resource.conflict` response. That independently established the immediate-retry defect.

## Implementation

### Separate account authority fencing from accounting contention

Authenticated session rows retain `FOR SHARE`; their deletion still waits for current holders. Active account/owner guards use `FOR KEY SHARE`, while quota/admission and admin quota edits use `FOR NO KEY UPDATE`. Account deletion retains its explicit `FOR UPDATE` barrier before marking the user deleting. That barrier conflicts with `KEY SHARE`; the change does not permit deletion to pass an already-authorized metadata transaction.

The real lock regression proves that accounting locking can coexist with an authority holder, while the deletion-strength lock cannot. Existing account-purge and in-flight-publication tests remain separate integrated acceptance requirements.

### Bound admission without reading every in-flight upload

The prior admission query read up to 128 active upload rows. Their concurrent lease, part acknowledgement and completion transactions interacted with the same owner's accounting, expanding serializable read/write dependencies even when names and upload IDs differed.

Migration `0007_upload_admission.sql` adds a private `pending_uploads` projection to the owner row, constrained to 0–128. `hyori_uploads.reservation_held` remains authoritative. One database trigger maintains the projection on insertion, deletion or a reservation/owner transition, in the same transaction; ordinary part/lease updates do not fire it. Upload ownership is immutable. Existing reservation inventory is counted during migration, not reset or deleted.

Reservation reads that one guarded owner counter under the existing accounting lock instead of scanning all active uploads. The existing 128-session cap includes zero-byte uploads. Completion, abort, expiry and account purge already change the reservation flag, so they inherit exactly-once slot release without separate feature bookkeeping. Media cache jobs do not reserve original-upload slots.

### Preserve bounded retries and truthful recovery

DB-only serializable callbacks still make at most four attempts for `40001`/`40P01`; storage, network and KDF work remain outside callbacks. Exponential jitter delays are 10–20, 20–40 and 40–80 ms before the remaining attempts. Exhaustion now returns existing `service.unavailable` (HTTP 503), not a domain conflict suggesting a name/revision/destination problem. Logs record only allowlisted SQLSTATE, attempt count and static upload phase, never raw SQL errors, credentials, names or object keys.

A failed final metadata transaction releases only its matching operation lease. The completed immutable object and durable intent remain available for immediate reconciliation through the same upload ID. Failed part-acknowledgement transactions also release only their own acquired lease. An ambiguous commit is not represented as proof that nothing was saved. Abrupt process loss can still require durable lease expiry; this change does not retract already committed content or remove terminal reconciliation inventory.

Real destination/name/revision/admission conflicts continue to use `resource.conflict`. Current authorization, quota, immutable versions, terminal replay and exact-key cleanup remain required.

## Focused evidence

The primary two regressions passed together three consecutive times after the complete fix: zero recorded deadlocks or HTTP failures in the defined two-client workload, and immediate finalization retry with one object and one quota charge.

The final focused run passed four real tests:

1. Two concurrent same-owner upload workflows, with accounting and PostgreSQL deadlock observations.
2. Forced final-publication serialization exhaustion, released fence, immediate same-ID reconciliation and terminal replay with one object/charge.
3. Existing-inventory migration backfill, 128 zero-byte admission cap, idempotent abort, transactional counter rollback and count/inventory agreement.
4. Account `KEY SHARE` compatibility with accounting and incompatibility with deletion's explicit `FOR UPDATE` lock.

```sh
# Use the pinned toolchain and native ICU configuration from the repository scripts/environment.
cargo test --locked -p hyori-server --test upload_contention -- \
  --ignored --nocapture --test-threads=1
```

The fixtures create random disposable credentials, loopback-only ports and isolated storage; they clean only their own containers. No deployment data, real environment file, existing service or volume was modified. The earlier browser/release images do not contain this fix. Rebuild before attributing browser success or performance to it, and retain the earlier metadata benchmark's original image/provenance unchanged.

## Request-disconnect follow-up (2026-11-05)

### Reproduction, not a timing inference

The earlier browser interruption evidence (271 and 18 conflict retries, success near 180 seconds) suggested a retained lease but did not establish its cause. The parent reports that image `sha256:ff0cbe390c3885d40635f5d68616ebdbbdc4c874c0a3790796910fb39746ac06` includes the serialization/admission/failed-publication fixes above and passed its release/HTTPS-Nitro SDK checks. This follow-up tested **local source**, not that image or a browser, and does not retroactively prove the cause of those older observations.

The locked HTTP implementation was inspected first: Axum 0.8 uses Hyper 1.12.0. Hyper's `proto/h1/conn.rs::mid_message_detect_eof` returns an error for EOF on a busy connection when half-close is disabled (the default); `proto/h1/dispatch.rs` owns the in-flight service future, which is dropped with the connection. Independently, `rpc::handle` drops its inner future after 30 seconds. An error-return branch in `UploadsService` cannot release a lease when that branch is never polled because its entire future was dropped.

`apps/server/tests/upload_disconnect.rs` and its dedicated support module use the production router over real TCP, real PostgreSQL 17 and RustFS `1.0.0-alpha.85`. A test-only proxy forwards the actual S3 operation, consumes its successful response, and holds that response behind a notification. The client then shuts down both directions of its real socket. An outer middleware Drop observer confirms the HTTP handler ended **before** the proxy is released; it neither cancels nor substitutes the service future.

**RED:** on the parent-fixed source before the request-lifetime change, both completion and part acknowledgement failed `disconnect must not strand the three-minute operation lease` after the bounded five-second observation. Completion's immutable object was independently verified by direct RustFS HEAD before disconnect. Both failures retained `lease_token` after the handler ended and storage response was released. No mock-future cancellation, lease-clock mutation or 180-second sleep established these failures. Fixture compilation/input mistakes were corrected before this behavioral RED; they are not counted as regression evidence.

### Narrow lifetime ownership

- `UploadsService::run_leased` owns only completion and part-write/acknowledgement lifetimes. Admission occurs **before** spawning, using the existing shared transfer semaphore; the owned permit stays with the worker through durable publication or fenced release. There are at most 16 such admitted tasks (fewer when other transfers occupy slots), not an unbounded detached queue.
- Each worker has a 125-second total operation deadline and at most five additional seconds for release. Normal storage deadlines can end work earlier. Release uses transaction-local database timeouts as well as the local timeout, and clears only `(upload ID, lease token)`; it cannot clear a newer owner's lease. A release failure is logged without private request data.
- `uploads/http.rs` transfers its existing permit into the part service; it no longer drops that capacity when a disconnected handler disappears. Completion acquires its owned permit in the service. The RPC response timeout remains 30 seconds; a response timeout/disconnect is not proof that the upload did not commit. Clients use the same upload ID to inspect/retry/replay the outcome.
- The existing `SERIALIZABLE` callbacks, four-attempt retry budget, current-authorization checks, revision fencing, immutable keys, quota/history bookkeeping and exact-key cleanup inventory are unchanged. No S3 operation moved inside a retry transaction, and no domain mutex was added.
- The negotiated app composition change adds `AppState::drain_transfers()` and calls it after Axum stops accepting/drains connections, before the database closes. It awaits all 16 existing permits and closes transfer admission. Disconnected workers therefore finish or hit their bounded deadline during orderly shutdown; no new task registry or separate gate was introduced.

A process/runtime crash, task panic, forced termination before graceful drain, or unavailable database during fenced release can still leave the durable lease until expiry. Remote S3 work may finish after local cancellation; the retained exact-key inventory and existing cleanup/tombstones remain necessary. The task deadline does not claim to cancel remote storage effects. This change does not alter ambiguous `uploads.begin` recovery or editor-start lease behavior.

### GREEN and limits

The final focused disconnect run passed **six real-service tests** in 92.40 seconds:

1. Disconnect after successful S3 completion of a replacement; same-ID retry and terminal replay return the same file, with two total immutable objects, six used bytes, zero reserved bytes/slots and exactly one historical version.
2. Disconnect after successful S3 part write; immediate part retry produces one acknowledgement, then completes with one object and one quota charge.
3. Sixteen held/disconnected completion workers retain all admission slots; the next completion receives 503. Graceful HTTP shutdown returns, but the app drain stays pending until every worker finishes, then closes admission. All sixteen files publish exactly once.
4. Public-grant revocation while disconnected completion is held prevents publication and releases the operation fence; the reserved intent remains for cleanup. Expiry cleanup removes the exact completed object and a later multipart effect at that key while preserving a prefix neighbour.
5. Account deletion while disconnected completion is held prevents publication; account purge removes the object and leaves no item, charge, history or reservation.
6. A disconnected worker with a withheld real S3 response exits through the real storage deadline without the test releasing that response first. The drain completed in **30.025 seconds**, with successful exact-key reconciliation and one publication. This measures that specific failure path, not production latency or the worst-case 125+5-second deadline. The full maximum-duration deadline and forced-process-crash expiry path were not separately wall-clock tested.

The existing four contention tests, all three `uploads` real-service tests, and `deleted_account_tombstones_reconcile_late_begin_and_fence_publishing_workers` also passed. The defined same-owner workload still reported zero deadlocks and zero request failures; bounded `40001` retries remained observable. All Docker fixture work was completed and owned containers removed before releasing the browser fixture's exclusive network window.

Commands (invoked with `scripts/rust-build-config.ts` supplying the native ICU environment, `CARGO_BUILD_JOBS=2`, `CARGO_PROFILE_TEST_DEBUG=0`, `RUST_TEST_THREADS=1`):

```sh
cargo test --locked -p hyori-server --test upload_disconnect -- \
  --ignored --nocapture --test-threads=1
cargo test --locked -p hyori-server --test uploads --test upload_contention -- \
  --ignored --nocapture --test-threads=1
cargo test --locked -p hyori-server --test admin \
  deleted_account_tombstones_reconcile_late_begin_and_fence_publishing_workers -- \
  --ignored --nocapture --test-threads=1
```

Source/toolchain provenance: Rust `1.99.1 (58cf8f9c3 2026-10-13)`, native ICU `78.3`, locked Cargo graph SHA-256 `996a120bc5d4b67b5307ef9853842cbf6e60480b60321cbe377e6cf684f07980`. Tested production-source SHA-256 values:

- `apps/server/src/features/uploads/service.rs`: `67352f38adf0d6f56c016380fd759e1a63a45aba7bce5d73de56d80dde318fda`
- `apps/server/src/features/uploads/http.rs`: `391e78112b538e60a58f90d4bf9bb5590dc92870bf8d352abbd241c174cd88d9`
- `apps/server/src/lib.rs`: `2e45515c94c093f062ac095eeff4522c2eec4d337c7f642adadf5edbd87d12ef`
- `apps/server/src/main.rs`: `cdb6a04f1815fe7d7c5a7aac454d9391c5bf6a3b324949c010b8742ec39697b1`

Functional evidence above is distinct from architecture/tooling evidence: package boundary checks passed across 294 files; no wire schema, SDK or UI boundary changed. Strict focused Clippy (`--lib --bin hyori-server --test upload_disconnect --all-features -- -D warnings`), affected-file rustfmt and diff-whitespace checks passed. The all-targets/all-features strict Clippy run found an unrelated concurrent listing test-module placement diagnostic in `features/files/service.rs` (`items_after_test_module`); this follow-up did not change that file. Root anti-slop passed after the fixture changes; the later shared-worktree run reported concurrent `scripts/metadata-query-experiments.ts` diagnostics at 1218 (`no-unknown-parameters`), 1224 and 1229 (`require-readable-spacing`), outside this follow-up's ownership. Browser/release acceptance must use a rebuilt image containing this lifetime change; it is not established by these direct-HTTP regressions.

## Same-owner queue and cleanup settling (2026-11-06)

### Observation

A real-browser run against a native release build (PostgreSQL 17, RustFS `1.0.0-alpha.85`, no containers) had one row in an ordinary batch of new files that needed a manual Retry. Traffic showed `uploads.complete` → 503 `service.unavailable`, and the server logged `upload_publication … transaction retry budget exhausted sqlstate="40001" attempts=4`. PostgreSQL reported SSI pivot cancellations on `hyori_uploads` writes for _different_ uploads, and `could not serialize access due to concurrent update` on the owner's `hyori_users` accounting row. Every reservation and publication updates that row, so under `SERIALIZABLE` two of the same owner's overlapping ones always cost one a retry. A busy batch can lose four in a row.

A scratch public-SDK stress run over that stack sent 300 two-KiB files from one owner with no injected faults. The pre-change server failed **3, 12 and 27** uploads at 2, 4 and 8 concurrent lanes, all with `service.unavailable`. Storage accounting stayed exact for the uploads that did commit.

### Change

- `db::OwnerLocks` holds 64 in-process async mutexes, striped by owner. `UploadsService::owner_domain` queues on the owner's stripe and then runs the unchanged `db::domain` transaction. Six transactions use it: begin's reservation and multipart record, part claim and acknowledgement, and completion's validation and publication. Storage and network work stay outside the lock, so it never covers an S3 call.
- The stripe comes from a hint read outside the transaction by immutable ID: the upload's owner, the destination item's owner, or the session's user for a root upload. The hint authorizes nothing. A wrong or missing hint only falls back to the existing retry path. Different processes don't share the queue, so the four-attempt retries remain the correctness mechanism, and this change only makes them rare.
- Upload cleanup still runs every second. When publications notify it during a burst, it waits for 500 ms with no further notification, capped at 5 s, so it doesn't scan `hyori_uploads` while the next ones commit. Cleanup is already off the save path.

### Evidence

With the change, the same stress run passed three repetitions of **500 files at 8 lanes**: zero failures, **zero** PostgreSQL serialization errors, zero exhausted retry budgets, and `usedBytes` equal to the bytes uploaded. With only the reservation/publication lock and no cleanup settling, 1 of 1,500 still failed. Without the settling, cleanup claims accounted for most of the remaining errors. `bun run check:rust` (format, all-target strict Clippy, workspace tests) passed. The Docker-based `upload_contention`, `uploads` and `upload_disconnect` real-service suites could not run on this orb, so rerun them before relying on this change. Uploads from one owner on one server now commit their database steps one at a time. That is a deliberate trade: each step is a few milliseconds and carries no storage I/O, and the 300-file run took about 5 s at 8 lanes.

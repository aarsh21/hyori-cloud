# Hyori Cloud backend

## Public boundaries

- `@hyori-cloud/api/rpc`: client-safe `ApiRpc`, the literal `operations` tuple, and feature-owned Effect schemas. `operations` contains each RPC declaration and its `kind`, optional invalidation namespace list, and optional cache-reset flag. It is not a second route/type registry.
- `@hyori-cloud/api`: server-only `createHandler(config)`, `Handler`, and `ServerConfig`; `Api` is a type-only export. Never import this entry point at runtime in browser code.
- `@hyori-cloud/core/rpc`: declaration aggregate, consumed by the API.
- `@hyori-cloud/core/server`: privileged request-scoped service binding and server capabilities. This is not a browser/local authorization bypass.
- Owned adapters: `@hyori-cloud/lib/{effect,effect/rpc,surreal,storage,crypto}`. Surreal uses parameter-bound HTTP RPC; RustFS uses the S3 multipart protocol through the owned AWS adapter.

Effect is pinned to **3.22.2**, RPC **0.76.2**, platform **0.97.2**. The wire below is a generic JSON adapter over those declarations, **not** Effect RPC's built-in NDJSON wire. Consumers derive all operation names, input/result/error codecs and metadata from the declaration aggregate.

## Mounting

```ts
import { createHandler } from '@hyori-cloud/api'

const handler = createHandler({
  origin: 'https://cloud.example.test',
  setupToken: /* externally generated secret, at least 24 characters */,
  secureCookies: true,
  basePath: '/api/rpc',
  storagePath: '/api/storage',
  defaultQuotaBytes: 10 * 1024 ** 3,
  surreal: { url, namespace, database, username, password },
  storage: { endpoint, region: 'us-east-1', bucket, accessKeyId, secretAccessKey },
  onError(error) { /* server-only structured diagnostics; do not return raw errors */ },
})

// Mount the SAME handler at the RPC path and all storage subpaths.
export const handleRequest = (request: Request) => handler(request)
// Trusted host job, NOT an unauthenticated HTTP operation:
await handler.maintenance()
// Host teardown:
handler.dispose()
```

The app owns environment parsing, URLs, deployment credentials and lifecycle. These packages do not read environment variables in production. The host must preserve the configured request origin through its reverse proxy. Production defaults require HTTPS; `secureCookies: false` is only for an explicitly configured HTTP development origin. Store the setup token out of client bundles and rotate/remove operator access to it after bootstrap. An initialized marker never resets when accounts are deleted.

Initialization is lazy and retryable: define tables/indexes and ensure the configured bucket exists. Missing services produce `service.unavailable`, never an empty/mock library or an uninitialized instance. Database/root and S3 credentials must remain server-side, and their network ports should be private. The configured bucket is an application-owned bucket; its object prefix is not a public read capability.

## JSON RPC wire

Request:

```http
POST /api/rpc
Content-Type: application/json
Origin: https://cloud.example.test
Cookie: hyori_session=...

{"operation":"files.list","input":{"parentId":null}}
```

Success: `{"ok":true,"value":<declared success>}`.
Failure: `{"ok":false,"error":{"code":"access.denied","message":"..."}}`.

The generic adapter validates the envelope, the selected RPC payload, the service result and the declared error shape. `createBindings` is statically checked against every composed RPC payload/result. Extra JSON object fields are ignored by the Effect schema decoder, not treated as authorization facts. Maximum JSON body size is 256 KiB. Unknown operations return 404. Stable errors use 400/401/403/404/409/429/503 statuses; clients must decode the error body rather than collapse all non-200 responses into a transport exception.

All RPCs use HTTP POST, including reads; declaration `kind` describes semantics, not the HTTP verb. Queries have no product mutations. In particular, `uploads.part` only returns a binary URL. `shares.resolve` is intentionally a mutation because a successful resolve establishes a share-access cookie.

Browser Fetch uses same-origin cookies. A vanilla client supplies a credential-aware Fetch implementation with a cookie jar and the configured `Origin`; no bearer-token substitute is provided. Session and public-share grant cookies are HttpOnly, SameSite=Strict, Path=/, Secure by default. Cookie-authenticated POST/PUT requires a same-origin `Origin` or browser `Sec-Fetch-Site` evidence; cross-site access is rejected. No CORS wildcard is emitted. Responses are no-store.

## File transfer protocol

1. `uploads.begin({parentId,name,size,mimeType,replaceId?})` reserves the destination owner's quota and creates a real RustFS multipart session. It returns `uploadId`, 8 MiB `chunkSize`, `totalParts`, acknowledged `parts`, `state`, and nullable `fileId`.
2. For each 1-based part, `uploads.part({uploadId,partNumber})` returns `{url,method:'PUT',headers:{}}`.
3. PUT the exact corresponding bytes to that application URL with the same cookies/Origin. The server checks authorization before storage and again before acknowledging the part. A repeated numbered part replaces that multipart part. Acknowledgments use `{ok:true,value:<UploadStatus>}`.
4. `uploads.status` discovers durable checkpoints after interruption/reload. The browser must reselect the same source file; no background filesystem permission is assumed. Zero-byte files have one zero-byte part. Maximum is 10,000 parts.
5. `uploads.complete` checks all parts, current authorization, quota, destination/name conflicts, and replacement revision. It freezes the session, completes RustFS storage, then atomically commits metadata/usage/version history. Failed replacements leave old committed bytes intact. Complete is replayable and returns the committed file under current access checks; a `finalizing` session can retry after an ambiguous storage response.
6. `uploads.abort` rejects committed sessions, atomically releases the quota reservation and marks cleanup before removing staged storage. The cleanup marker remains durable for late in-flight storage work. Parts/complete from an aborted or revoked session cannot publish a file.

Do not automatically replay `begin` after an ambiguous response: it has no idempotency key and the unknown session may still reserve quota until expiry. Active sessions expire after seven days. Lost/expired reservations require the host's maintenance job. Concurrent same-number uploads should be avoided; ETag mismatch fails completion rather than silently committing mismatched bytes.

`files.download({id,versionId?})` yields a same-origin app URL, never an S3 URL. GET re-authorizes current session/share access and streams storage bytes, including a single HTTP byte range. History access is owner-only. Binary responses are attachment/no-store/nosniff/sandbox, preventing an uploaded HTML/SVG document from executing in the application origin. Newly authorized reads stop after expiry/revocation; a response stream already opened while authorized may finish. Bytes already downloaded cannot be revoked. An in-flight upload may reach temporary object storage after revocation but cannot commit file metadata without another successful current authorization check.

## Implemented policy and lifecycle defaults

These are explicit implementation defaults, not amendments to `docs/product.md`:

- Bootstrap is token-protected and uses a permanent Surreal control record plus an atomic compare-and-swap transaction. Concurrent application processes cannot both establish the first administrator.
- Passwords are salted scrypt (N=32768, r=8, p=1), with a 12-character minimum on creation. KDF execution is bounded to two concurrent operations and 32 waiting requests per process. Login/setup/invite/link-password attempts have persistent ten-attempt/15-minute buckets. Rate limits are not a complete perimeter abuse-control system.
- Sessions expire after seven days; public-link grants after twelve hours. Public links use independent grant cookies, so opening another link does not replace an existing link's authorization or interrupt its uploads. Cookie retention and each authorization lookup are bounded to sixteen public-link grants per browser; opening more can require reopening an older link. Tokens are random, stored only as SHA-256 digests. Each request reloads active account/share state. An unverified email is not used as proof of identity or as an automatic share recipient; account shares use explicit account IDs.
- A duplicate direct share for the same item/account is rejected with `resource.conflict`; revoke the existing direct share before assigning a different role. Inherited grants remain independent. The strongest currently active direct/inherited share role wins. Owner is a separate capability, not a fourth role. Shared uploads belong to the destination owner, with separate authenticated/anonymous attribution. Admin status never enters ordinary file authorization.
- File/folder/upload/album names are trimmed and NFC-normalized, then checked against the final 1–255 character limit and valid Unicode/path constraints before persistence. Legacy malformed names are safely encoded in attachment headers.
- Item deletion, moves, resharing and history access/restore are owner-only. Editor can rename/replace existing content, including a directly shared file without parent-folder listing access. Contributor can add new files/folders but cannot replace. Cross-owner moves are rejected.
- Trash propagates through a subtree, preserves independently pre-trashed descendants, and restores only the selected trash group. Folder move/trash/restore is currently bounded to **1,000 descendants**, with an explicit conflict rather than partial mutation. Folder nesting is at most 64 levels. These limits need product/deployment validation before launch.
- Retained originals/versions/trash all count toward quota; pending uploads reserve their full future object size. Replacement adds its full new object size because old bytes remain recoverable. Restoring a prior version reuses an already-counted immutable object. Quota reductions below usage are allowed but block further publishing/writes until usage fits. There is no automatic trash/version retention eviction yet.
- Account deletion requires the exact email confirmation, immediately marks the account unavailable, then removes owned objects, owned metadata, sessions, issued shares/invites and personal photo configuration in bounded batches. Contributions owned by other users survive. It returns `pending` when another sweep is necessary. The bootstrap admin cannot be deleted. No file names are returned to the administrator.
- Deleted-account tombstones retain only a non-registrable synthetic identity and aggregate zeroes, so an existing account cannot occupy their email-index slot; maintenance repeatedly sweeps their storage prefixes to catch late storage completions. This is irreversible account purge, not ordinary trash/restore.
- File listing/search uses opaque keyset cursors, up to 100 results, case-insensitive substring names, MIME/kind type filters, inclusive updated-at and size filters. Results and breadcrumbs are access-scoped. Searches in an explicit folder retain that parent scope; searches in Shared with me exclude owned items. Root Files searches span the authorized library. File listing order is stable opaque ID order, not a user-selectable sort yet.
- Photos source selection is personal and grants no access. Timeline uses upload-created timestamp descending and current file authorization, not EXIF capture dates. Supported declared MIME types: JPEG, PNG, WebP, GIF, AVIF, MP4, WebM and QuickTime. Albums are personal references, capped at 100 albums/1,000 references each; their count is stored reference count, while rendered media is current-access filtered. Unavailable/trashed sources are omitted on read and reconciled away when saving sources, so a lost grant cannot lock source configuration. Removing a source never changes the original. Timeline items include a server-owned `previewUrl` for the original, avoiding a metadata RPC per tile; every binary GET still re-authorizes current access.

## Persistence and maintenance responsibilities

No in-memory/mock persistence implementation is selected by production. All metadata, sessions, shares, checkpoints and quota reservations live in SurrealDB; bytes live in RustFS.

Services read through a transaction capability. Writes commit parameter-bound statements with a global revision compare-and-swap; successful read-only operations revalidate that revision before returning without issuing writes. Authorization and invariants are re-evaluated on conflict, across processes, preventing a read from mixing stale sharing scope with newly private metadata. Callbacks have no object-storage/network side effects. This deliberately favors initial correctness over throughput: **the global write revision is a known contention bottleneck** and requires representative benchmarking and a finer-grained transactional design before high-write deployments. No throughput claim is made.

Storage and database do not share a transaction. The upload state machine keeps completed-but-uncommitted objects private and replayable, and durable cancellation/account tombstones provide cleanup work. The host must invoke `handler.maintenance()` repeatedly (for example a trusted process scheduler every minute), monitor failures, and retain scheduling through restarts. Each call processes up to 25 upload/account records; in-process cursors provide fair subsequent sweeps, while durable records preserve recovery across restarts. Multipart cleanup enumerates at most 100 sessions per exact durable object key per pass, including unknown IDs and ambiguous-create duplicates, and never aborts prefix-neighbour keys. Durable markers catch late storage requests; completed-upload reconciliation aborts unfinished duplicates without deleting the committed original or releasing quota again. Those retained markers add bounded recurring maintenance work; no retention/throughput claim is made. There is no public maintenance endpoint. Without that job, abandoned upload quota/storage and pending account cleanup can remain indefinitely.

## Verification

```sh
bun run --cwd packages/core check-types
bun run --cwd packages/api check-types
bun test packages/core/test packages/api/test
```

Real-service test gates require both `HYORI_TEST_SURREAL_URL` and `HYORI_TEST_STORAGE_ENDPOINT`; absent those, the suite is explicitly skipped. Optional credentials: `HYORI_TEST_SURREAL_USER`, `HYORI_TEST_SURREAL_PASSWORD`, `HYORI_TEST_STORAGE_ACCESS_KEY`, `HYORI_TEST_STORAGE_SECRET_KEY`. The parent owns isolated service startup/teardown. Each run creates a unique database and bucket in those **test services**.

Functional evidence includes real bootstrap races, account/admin isolation, multipart checkpointing and bytes, rejected incomplete replacement, version restoration, inherited roles/owner-only deletion, public-link password/revocation, quota, trash, photos and account-purge ownership. Architecture evidence (boundary lint, SDK derivation, packed consumer/bundle checks) is separate and owned by the SDK/parent integration work.

## Incomplete v1 work / deployment cautions

- Web upload replacement/new-version creation is not exposed yet; the public API supports it, but duplicate-name web uploads fail rather than silently overwrite. History/restore UI can consume versions created through the API.
- ArtCraft browser open/save, locking and fidelity are not implemented here; no editor success placeholder is exposed. Revision-based replacements prevent silent stale saves but are not an editor lock protocol.
- Derived media/thumbnail processing and content-validated preview generation are not implemented. The web viewer uses authorized originals where the browser supports the media type; single-file public links remain download-only. The backend exposes originals plus authorized metadata, not derived previews.
- No automatic version/trash expiry or permanent item-purge UI/API, album removal/sharing, capture-date extraction, credential recovery/password rotation or admin promotion path yet.
- Full idempotency keys for upload-begin/account creation, API cancellation propagation, streamed chunk ingestion without the bounded 8-MiB buffer, distributed KDF admission, per-host request/body timeouts, fair multi-process cleanup leases and more detailed operational metrics remain work.
- Account purge retries, service outages during finalization, empty-file multipart behavior, expiry transitions and production HTTPS/proxy behavior require explicit real-service evidence; a typecheck is not proof of these scenarios.
- Root database authentication and bucket bootstrap are deployment conveniences, not a least-privilege service-account provisioning system. Backups, encryption at rest, key rotation, upgrades and service compatibility remain host responsibilities.

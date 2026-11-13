# Hyori Cloud client SDK

The root is framework-independent. RPC, query and mutation method trees derive from the feature-owned `operations` tuple exported by `@hyori-cloud/api/client`; the SDK contains no handwritten method catalog. That lightweight catalog and the compatible `@hyori-cloud/api/rpc` catalog are generated from the same Rust manifest and supply identical payload, success and expected-failure runtime codecs. The wire protocol is documented in `../../docs/implementation-contract.md`.

```ts
import { createClient } from "@hyori-cloud/client-sdk";

const sdkClient = createClient({
  baseUrl: "/api/rpc",
  cacheScope: "account-id", // non-secret; never a token/password
});
await sdkClient.rpc.files.createFolder({ parentId: null, name: "Pictures" });
```

Browser requests use same-origin credentials by default. A non-browser/CLI client supplies an absolute `baseUrl` and an explicitly credential-aware Fetch implementation; the SDK does not invent a cookie jar. Configuration is resolved once at client construction. A client owns in-flight request cancellation and upload handles: call `dispose()` when its credential/request lifetime ends. Do not dispose a browser singleton on every route change.

## React and Query

The app owns a stable SDK instance and one browser QueryClient; server requests get separate QueryClients and credential-bearing SDK instances. `ClientSDKProvider` only injects the SDK; it does not own or construct a cache.

```tsx
import {
  ClientSDKProvider,
  setMutationDefaults,
  useClientSDK,
} from "@hyori-cloud/client-sdk/react";
import {
  createQueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
} from "@hyori-cloud/lib/query";

const queryClient = createQueryClient();
setMutationDefaults(queryClient); // once per newly constructed cache

// App root:
<QueryClientProvider client={queryClient}>
  <ClientSDKProvider sdkClient={sdkClient}>{children}</ClientSDKProvider>
</QueryClientProvider>;

// Feature-local hooks; return the tracked query/native mutation result unchanged.
function useFiles() {
  return useQuery(useClientSDK().query.files.list.getOptions({ parentId: null }));
}
function useCreateFolder() {
  return useMutation(useClientSDK().mutation.files.createFolder.mutationOptions());
}
```

Keys derive from operation identity: `.key` is an operation prefix; `.getOptions(input).queryKey` and `.getKey(input)` include scope and all inputs. `getKey` retains result/error types for Query cache operations. Exact invalidation requires `exact: true`. Keys never include transport credentials. Do not put share tokens/passwords in query inputs; the share-grant operations are mutations and use HttpOnly cookies.

Mutation options deliberately omit lifecycle callbacks so registered defaults survive. The installer derives invalidation from declaration metadata. Credential-changing mutations cancel in-flight queries, purge non-identity data and invalidate identity reads. Other mutations invalidate every input/scope of the affected declared namespace, intentionally; separate QueryClients remain isolated. Hooks must not override these callbacks or invent a key registry.

`InputOf`, `OutputOf`, `ErrorOf`, `ResourceOf` and `SuspenseResourceOf` preserve originating-operation types on descriptors and option factories. Resource helpers reject mutation descriptors. `ResourceOf` is a distributive, type-only projection, not a runtime mapper. Ordinary and Suspense options share the same callable query function; this does not promise identical TanStack Suspense cancellation semantics.

## Upload lifecycle

```ts
const task = sdkClient.uploads.start(
  { parentId: null, file }, // File, or a host implementation exposing bounded Blob slices
  {
    onProgress(snapshot) {
      renderAcknowledgedBytes(snapshot.uploadedBytes);
    },
  },
);
const committedFile = await task.result;
```

The vanilla helper owns serial, bounded chunk sequencing, acquisition of current-authorized part capabilities, bounded exponential part retries, cancellation and checkpoint reconciliation. It never buffers a complete file. Progress is **acknowledged bytes per part**, not socket-level progress; frequent updates are not fabricated between acknowledgements. Browser File APIs and Fetch are capabilities, not React dependencies.

- `task.pause()` aborts local work and preserves the server checkpoint. `task.retry()` reconciles server status and resumes the same upload. Concurrent retries share the active promise.
- `await task.cancel()` aborts local work and requests server abort. Abort failure is visible and must not be represented as confirmed server cancellation. An explicitly cancelled task cannot replay itself.
- `task.getSnapshot()` / `subscribe()` expose immutable, runtime-schema-derived discriminated snapshots. Completion requires a committed file/checkpoint; failure requires a normalized error; live states cannot carry a completed file. `useUpload(task)` is an optional `useSyncExternalStore` bridge, with no effect hook or duplicated transfer policy. Once `finalizing` begins, pause/cancel waits for the authoritative commit result rather than promising to retract it.
- `task.result` represents the current attempt. A paused/failed attempt rejects; use the promise returned by `retry()` for the next attempt. Hosts own persistence of `snapshot.checkpoint`. `task.dispose()` releases listeners and the client's retained file/task reference while preserving the server checkpoint; a disposed task cannot restart.
- After reload, decode stored metadata with `decodeUploadCheckpoint`, reselect the local file and call `uploads.resume({ checkpoint, file, confirmSameFile: true })`. Metadata equality (name/size/type/lastModified) is checked, but **cannot prove identical bytes**. The user must reselect the original file; no unrestricted background filesystem access, persisted file bytes or browser restart auto-resume is claimed. Checkpoints identify uploads, not authorization: the backend rechecks current access.
- Begin/complete are not automatically replayed after an ambiguous network failure. Manual retry reconciles status. Completion is backend-idempotent and can recover an already committed file without replacing it twice. A lost begin response cannot recover its unknown ID; backend retention/maintenance must reclaim it (currently seven days). HTTP capabilities expire independently; retries request fresh capabilities.
- Upload responses are validated; chunk size must be positive and no more than 64 MiB. The current backend uses 8 MiB and a maximum of 10,000 parts. The helper validates part numbers, acknowledged sizes and zero-byte upload geometry.

To use upload lifecycle completion with Query's consistency policy, bind the lifecycle mutation function to the derived `mutation.uploads.complete` key. The `uploadMutationOptions` React integration helper does that without local invalidation; it remains the vanilla helper that sequences bytes. `downloads.open(input)` returns validated metadata and a readable byte stream for a host-owned sink; it does not buffer or save an entire file.

### Explicit replacements and durable local intent

```ts
import { createUploadQueue, getUploadFailure } from "@hyori-cloud/client-sdk";
import type { ReplaceUpload } from "@hyori-cloud/client-sdk";

// Original local source, e.g. edited.docx; never rename/proxy it to match the target.
const replacement: ReplaceUpload = {
  file,
  parentId: target.parentId,
  target: { id: target.id, name: target.name }, // e.g. report.docx
};
const task = sdkClient.uploads.replace(replacement);
// Or let the existing two-transfer queue own admission and retry:
const queue = createUploadQueue(sdkClient, checkpointStore);
queue.replace(replacement);

for (const entry of queue.getEntries()) {
  renderName(entry.intent.name); // target name for replacements, including interrupted rows
  if (entry.intent.kind === "replacement") renderNewVersion(entry.intent.targetId);
  if (entry.state === "started") {
    const snapshot = entry.task.getSnapshot();
    if (snapshot.status === "failed") {
      renderFailure(getUploadFailure(entry.intent, snapshot.error));
    }
  } else if (entry.state === "interrupted" && entry.error) {
    renderFailure(getUploadFailure(entry.intent, entry.error));
  }
}
```

`ReplaceUpload` is the shared input to raw `uploads.replace` and queued `queue.replace`. This is an explicit operation, not a duplicate-filename heuristic. Ordinary `uploads.start` / `queue.add` remain new-file operations unless the existing raw `start({ replaceId, ... })` is explicitly used. That backwards-compatible signature still sends the local filename as the target name; use `replace` when they differ. Browser-picked/dropped names never imply replacement. Do not call both raw and queued operations for the same user action; the example illustrates the two independent entry points.

`UploadIntent` is a feature-local runtime schema and inferred type, available as `task.intent` and `entry.intent` for **all** queue states:

- `{ kind: "new", name }`: creating a new file.
- `{ kind: "replacement", name, targetId }`: explicit replacement; `name` is the server target name, not necessarily the source filename.
- `{ kind: "legacy", name }`: a v1 checkpoint whose intent is unknown. V1 did not persist replacement metadata, so the SDK cannot honestly recover its tag/target or distinguish a duplicate-name conflict from a stale version. It does not infer intent from matching names or migrate unknown intent to `new`.

New tasks emit version **2** checkpoints containing `{ version, uploadId, file, intent }`. `file` always fingerprints the **actual local source** by name/size/type/lastModified; `intent` carries the target name/ID separately. V2 requires a valid explicit new/replacement intent. Existing v1 `{ version: 1, uploadId, file }` checkpoints remain valid and resume unchanged, without replaying begin. `decodeUploadCheckpoint` rejects unsupported versions, malformed fingerprints/targets, unknown fields (including bytes/handles), and a v1 checkpoint carrying unversioned intent. Saved values must be decoded before use; `uploads.resume` also validates its runtime input. Queue storage validates and deduplicates rows; malformed persisted rows are not resumed.

Reselection and `confirmSameFile: true` still apply to the original local file, even when the target's name differs. Metadata is not a content hash; matching metadata cannot detect changed bytes with exactly the same metadata. Queue `resume(id, file)` remains the explicit host-confirmed reselection action. Neither source handles nor bytes are persisted. Intent is local recovery/presentation metadata, **not** authorization or the server's revision baseline. The server retains the upload's target/revision and rechecks access; resume and retry reconcile status on the same upload ID, never begin a fresh replacement or bypass a stale-version conflict.

`getUploadFailure(intent, error)` returns framework-free semantic tokens: `replacement-conflict` for an explicit replacement conflict, `replacement-failed` for its other failures, `upload-conflict` for a known new-file conflict, and `upload-failed` otherwise (including unknown legacy intent). A generic `resource.conflict` does not prove a duplicate name or stale revision: the destination, transfer state or lease can also conflict. Hosts must explain the conflict without inventing its precise cause. Failed publication never overwrites previously committed immutable bytes, but a lost response can leave the client uncertain after a successful commit; failure copy must not claim that the current file is unchanged until reconciled. Retry/status on the same upload ID resolves that ambiguity. A failed cancellation still uses the existing **snapshot** `intent: "cancel"` action field; this is distinct from **task/entry** `intent` describing what is being uploaded. Cancellation-specific UI should check that action before choosing transfer-failure copy.

UI migration: remove source proxies, file/task WeakMaps/WeakSets and decorated SDK clients. Pass the unmodified SDK to `createQueryUploadQueue`; call its `replace({ file, parentId, target: { id, name } })`. Use `entry.intent` for waiting/interrupted tags and target names, `task.intent` or `entry.intent` for started tags, and `getUploadFailure` for transfer failure semantics. Keep the existing `useUploadEntries`, `useUploadSummary`, `useUpload`, retry/cancel actions and host-confirmed `resume` path. No new queue, effect, Query cache, invalidation callback, or feature-side protocol reconstruction is needed.

### Multi-file queues

`createUploadQueue(sdkClient, checkpointStore)` owns portable admission (at most two active transfers), retry/resume scheduling, checkpoint validation/deduplication and retention. Hosts inject only metadata `read`/`write` storage. `createQueryUploadQueue(sdkClient, queryClient, checkpointStore)` from `./react` applies the very same declaration-derived completion policy after first-attempt, retried or resumed task success—there is no UI invalidation registry. Observe `useUploadEntries(queue)` and `useUploadSummary(queue)`. Call queue actions (`retry(id)`, `cancel(id)`, etc.), rather than directly retrying its task and bypassing admission. A started entry's `retryQueued` flag reports an accepted retry waiting for a transfer slot; it does not pretend that bytes are already transferring. Observe the queue to render that state, rather than copying admission into React. Cancellation is asynchronous and must confirm server abort; `dismiss` only removes locally safe rows, not retained server checkpoints. The queue exposes persistence failures separately and `dispose()` pauses work, writes recoverable checkpoints and releases listeners. Its host owner must dispose it when the session scope leaves; a new scope needs a new queue.

## Editor attachment protocol (integration in progress)

The new [native runtime protocol 2](../../docs/editor-runtime-protocol.md) has one strict schema/type owner exported as `@hyori-cloud/client-sdk/editor-runtime`. It adds correlated native capture, draft-aware durable acknowledgement, and real native theme commands. The public local contract includes autosave options, `requestSave`, `setTheme`, `snapshot.autosave`, and `lastSavedAt`; controller/native/browser integration is in progress. These source contracts do not enable autosave in the currently shipping manual runtime. See the [measurement plan and provisional budgets](../../docs/editor-performance.md); no measured speed claim follows from adding the protocol.

`createEditorSession`, `EditorDocument`, and the editor capability/state types are deliberate vanilla root exports. Browser frame mechanics live at `@hyori-cloud/client-sdk/browser` as `createBrowserEditorMessages`; importing the root does not import browser globals or React. The composition owner supplies an `EditorBackendPort` and the exact captured frame/window capability, and disposes the session **before** navigating/removing its iframe. The backend port is a local capability contract, not a handwritten mirror of Rust operations.

The local controller supports the three pinned upstream message families and separately versioned DeckCraft **`0.14.1-hyori-host.2`** protocol 1. Historical `.1` remains accepted only with an exactly matching descriptor/message version for retained controller fixtures; this does not authorize deploying it. Unknown future versions and official DeckCraft `0.14.1` remain unsupported. Protocol support alone does not approve or ship an artifact. All events require exact origin and captured window identity. Modified DeckCraft additionally binds version, fresh attachment `openId`, ordered stable `saveId`, and explicit successful parsing acknowledgement. Readiness or successful `postMessage` delivery is not an opened document. Reloaded-frame readiness ends the attachment instead of replaying over unsaved state.

The local backend port accepts the generated optional `saveMode: "manual" | "automatic"` alongside each retained attempt. The binding preserves both the value and omission across retries (old clients omit it), forwards it to generated `editors.prepareSave`, and rejects an automatic non-replacement before any local destination chooser runs. Rust owns checkpoint/replay/GC policy; a client flag grants no authorization. New policy source is not yet deployed.

All four editors receive a stable ID per admitted output, forwarded as required `saveId` to `EditorBackendPort.save`: DeckCraft supplies its correlated ID; the SDK allocates a UUID for legacy vendor protocols and keeps it across retries. The Rust binding durably deduplicates these IDs and atomically enforces the revision originally opened, current access, output intent/format, quota and immutable history. A lost backend reply retains the same ID, revision and bytes for explicit retry, **not** a claim that no commit occurred. An actual successful save followed by a failed child acknowledgement retries only the acknowledgement. Duplicate current/completed vendor messages do not repeat persistence; changed bytes under a reused ID and stale/out-of-order IDs are rejected. The completed acknowledgement cache retains only the latest bounded snapshot. A child `clean`/`saved` event never substitutes for backend durability, and newer edits remain dirty after an older save completes.

Byte/name validation, bounded copies, one active save plus one safely coalesced legacy queue entry, recovery outputs, Save As detachment, export/source-revision separation, current server failure states and disposal remain SDK-owned. Modified DeckCraft allows one correlated pending output, capped by the descriptor and a 64 MiB hard limit. Copying/serialization and duplicate-byte comparisons are bounded but have **not** been profiled on representative devices. The configured ceiling is not a measured memory or responsiveness budget.

The public backend binding is owned by the root client:

```ts
const backend = sdkClient.editors.backend({
  id: file.id,
  // Required only for Save As/export; never inferred from the opened file:
  destination: { parentId: null },
});
const session = createEditorSession({ backend, messages, maxBytes });
```

`sdkClient.query.editors.available.getOptions({})` derives one instance-level availability query returning enabled app/version/input-extension entries; it reveals no file permissions. A host can cache that result for entry points, but `editors.open` still freshly authorizes each file. The required `EditorDocument.assetUrl` is server-selected and must be consumed verbatim, not reconstructed from a second app/version map.

Alternatively, inject `chooseDestination(output, { signal })` returning an explicit `{ parentId }` or `null` rather than a fixed destination. Cancelling selection retains a recoverable failed output; it never silently writes to root. The binding owns the SHA-256 calculation, bounded original download/output copy, prepared-upload resume and authoritative completion. It does not start a second ordinary upload or reconstruct authorization in the host. Server-provided output formats and per-format size limits are authoritative.

Imported PPTX documents are not replacement targets: the modified Deck host requests an explicit native `.deckcraft` copy. The attachment does not adopt the new file as its source, so subsequent saves from that original PPTX request another copy and destination. Open the newly created native file for ordinary replacement saves. Name collisions are rejected rather than silently overwriting an existing file; real `.2` WASM acceptance remains separate from these protocol/patch tests.

A read-only source can produce an explicit copy or export to an independently writable destination; this never grants replacement rights or advances the source revision. The controller retains read-only state after success, and an explicit copy can supersede a locally blocked replacement output. A changed source baseline still conflicts; conflict recovery is download-only rather than a blind retry or a silently rebased copy.

Retire an attachment with `session.dispose()` (or await `backend.close()` for a vanilla consumer). The binding uses generated `editors.close({ sessionId })`, which frees a clean server handle without changing files/history. Root client disposal also retires owned handles. Once publication might have happened, cleanup retains uncertain save/replay state until authoritative completion rather than deleting it to free a slot. Disposal never means a save succeeded, and local recovery copies remain available from the disposed controller.

Cleanup requests use the transport's explicit `keepalive` option with a ten-second abort bound. Already-admitted cleanup may finish after client disposal; new requests remain forbidden. Page exit, a lost open reply, invalidated credentials, unreachable servers, and unresolved publication can still leave sessions for bounded server expiry. Existing pre-update rows are not globally evicted. The live-session caps remain 32 per actor and 256 per owner; explicit close releases normal usage instead of increasing those caps.

React hosts can inject `createQueryEditorBackend(sdkClient, queryClient, options, onReconciliationError?)` from `./react`, then observe `useEditorSession(session)`. This uses the generated `editors.completeSave` consistency policy, not feature-local invalidation. A cache-refresh failure is reported separately and cannot turn a confirmed save into a failed persistence result. The composition owner still owns session/frame lifetime; the observer does not create or dispose sessions.

Public controller/cache tests use explicit fake ports/backend capabilities. Separately, `bun run test:rust-editors-sdk` at the repository root exercises actual Rust/PostgreSQL/RustFS through this public SDK: disabled asset gates, original download, lost completion response plus restart/same-ID replay, stale revision/descriptor rejection, explicit destinations, native Deck input/PDF export, and anonymous Editor revocation. That harness now supplies an explicitly synthetic, verified read-only inventory accepted only in development on loopback, and explicitly toggles its private database gate; no vendor renderer is shipped by that fixture. Production runtime capability requires the separately pinned verified bundle, current operational gate and same-origin static delivery; see [runtime deployment](../../docs/editor-deployment.md). The real-bundle frame probe has exercised edits through the host/controller with page-memory persistence, including historical Deck `.1`; it is not WASM → SDK → Rust durability or final `.2` acceptance. All-four composed browser persistence and freshly reopened content remain pending. Keep those evidence boundaries separate from format fidelity and the asset/notice records in `../../docs/artcraft-integration.md` and `../../docs/editor-persistence.md`.

## Local artifact contract

The supported direct source-artifact runtime is **Bun 1.4.4**. SDK, generated API and library manifests declare it and pack their `src` files; public exports and private `#...` imports resolve inside each tarball. These are ESM TypeScript source artifacts, not built JavaScript/declaration bundles. Direct Node execution, other Bun versions, native clients and browser-bundler distribution compatibility are not established by this gate. The web application's Vite build is a separate consumer.

TypeScript consumers use TypeScript 6.0.3, `moduleResolution: "Bundler"`, `module: "ESNext"`, `target: "ESNext"`, `noEmit: true`, `allowImportingTsExtensions: true`, and ESNext/DOM/DOM.Iterable libraries. Include Node-compatible ambient types (`@types/node`, tested at 26.6.6 with `types: ["node"]`): transitive RPC codec declarations reference `Buffer`/streams. This does not require React or Bun ambient types. The external fixture uses strict checking with **`skipLibCheck: false`**.

The vanilla dependency closure contains no React, React types, React Query, icons or web framework. `./react` requires the declared optional adapter peers: React 19, `@tanstack/react-query` **5.104.2**, and React 19 types (include `"react"` in the consumer's `types`). The owned library's `./query` and `./react` share those peers; `./icons` separately requires its declared `lucide-react` peer. Library adapter dependencies are development dependencies plus optional peers, not vanilla runtime dependencies.

Run **`bun run check:artifacts`** from the repository after the locked workspace install. It performs no registry access, publication or package lifecycle scripts. It creates three real tarballs with `bun pm pack --ignore-scripts`, unpacks them outside the workspace, and copies only declared installed dependency closures (plus explicitly selected consumer tools/peers), never workspace links or path mappings. Vanilla and React consumers separately typecheck and execute the public exports with fake Fetch. Negative checks require missing peers, private source paths and a missing owned artifact to fail. All temporary artifacts are removed, and CI requires this check. See [architecture acceptance](../../tooling/architecture/README.md#packed-artifact-gate) for details.

## Verification boundaries

`bun run check-types`, `bun run test:compile` and `bun test tests` exercise the public SDK, real TanStack cache/providers, and explicit fake API/storage. These are not evidence of real PostgreSQL/RustFS durability or authorization. The repository-level Fernando gate additionally checks isolated declaration evolution and executable lint regressions; that alias-based evolution fixture is not artifact evidence. `check:artifacts` establishes the bounded Bun/source-artifact contract above, not actual browser/app bootstrap behavior, service durability, registry installation/publication, universal portability or measured type/bundle/runtime budgets. Those remain separate acceptance work.

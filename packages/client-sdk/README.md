# Hyori Cloud client SDK

The root is framework-independent. RPC, query and mutation method trees derive from the feature-owned `operations` tuple exported by `@hyori-cloud/api/rpc`; the SDK contains no second method catalog. The same declaration supplies payload, success and expected-failure runtime codecs. The wire protocol is documented in `../../docs/implementation-contract.md`.

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

### Multi-file queues

`createUploadQueue(sdkClient, checkpointStore)` owns portable admission (at most two active transfers), retry/resume scheduling, checkpoint validation/deduplication and retention. Hosts inject only metadata `read`/`write` storage. `createQueryUploadQueue(sdkClient, queryClient, checkpointStore)` from `./react` applies the very same declaration-derived completion policy after first-attempt, retried or resumed task success—there is no UI invalidation registry. Observe `useUploadEntries(queue)` and `useUploadSummary(queue)`. Call queue actions (`retry(id)`, `cancel(id)`, etc.), rather than directly retrying its task and bypassing admission. Cancellation is asynchronous and must confirm server abort; `dismiss` only removes locally safe rows, not retained server checkpoints. The queue exposes persistence failures separately and `dispose()` pauses work, writes recoverable checkpoints and releases listeners. Its host owner must dispose it when the session scope leaves; a new scope needs a new queue.

## Local artifact contract

The supported direct source-artifact runtime is **Bun 1.4.4**. SDK, API, core and library manifests declare it and pack their `src` files; public exports and private `#...` imports resolve inside each tarball. These are ESM TypeScript source artifacts, not built JavaScript/declaration bundles. Direct Node execution, other Bun versions, native clients and browser-bundler distribution compatibility are not established by this gate. The web application's Vite build is a separate consumer.

TypeScript consumers use TypeScript 6.0.3, `moduleResolution: "Bundler"`, `module: "ESNext"`, `target: "ESNext"`, `noEmit: true`, `allowImportingTsExtensions: true`, and ESNext/DOM/DOM.Iterable libraries. Include Node-compatible ambient types (`@types/node`, tested at 26.6.6 with `types: ["node"]`): transitive RPC codec declarations reference `Buffer`/streams. This does not require React or Bun ambient types. The external fixture uses strict checking with **`skipLibCheck: false`**.

The vanilla dependency closure contains no React, React types, React Query, icons or web framework. `./react` requires the declared optional adapter peers: React 19, `@tanstack/react-query` **5.104.2**, and React 19 types (include `"react"` in the consumer's `types`). The owned library's `./query` and `./react` share those peers; `./icons` separately requires its declared `lucide-react` peer. Library adapter dependencies are development dependencies plus optional peers, not vanilla runtime dependencies.

Run **`bun run check:artifacts`** from the repository after the locked workspace install. It performs no registry access, publication or package lifecycle scripts. It creates four real tarballs with `bun pm pack --ignore-scripts`, unpacks them outside the workspace, and copies only declared installed dependency closures (plus explicitly selected consumer tools/peers), never workspace links or path mappings. Vanilla and React consumers separately typecheck and execute the public exports with fake Fetch. Negative checks require missing peers, private source paths and a missing owned artifact to fail. All temporary artifacts are removed, and CI requires this check. See [architecture acceptance](../../tooling/architecture/README.md#packed-artifact-gate) for details.

## Verification boundaries

`bun run check-types`, `bun run test:compile` and `bun test tests` exercise the public SDK, real TanStack cache/providers, and explicit fake API/storage. These are not evidence of real SurrealDB/RustFS durability or authorization. The repository-level Fernando gate additionally checks isolated declaration evolution and executable lint regressions; that alias-based evolution fixture is not artifact evidence. `check:artifacts` establishes the bounded Bun/source-artifact contract above, not actual browser/app bootstrap behavior, service durability, registry installation/publication, universal portability or measured type/bundle/runtime budgets. Those remain separate acceptance work.

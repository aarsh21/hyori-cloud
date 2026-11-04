# V1 implementation handoff

Status: implementation started. Product scope is authoritative in `product.md`; this note assigns owners and fixes the initial consumption contract so parallel work composes. It is not evidence of implemented functionality.

## Owners

- **Astra 6 Fast High:** `packages/core`, `packages/api`, and `packages/lib` server adapters and package manifest. Own feature-local schemas/Effect RPC declarations, authorized services, SurrealDB persistence, RustFS adapter, and the composed HTTP API. Publish declarations first. Do not edit UI, SDK, root manifests/lockfile, or deployment files.
- **Sol 6.1 Fast High:** `packages/client-sdk`, `packages/lib` React/Query/Effect facade files (coordinate through this note; do not edit its package manifest), architecture/acceptance tooling under `tooling`, and SDK tests. Own generic contract-derived transport/Query integration and reusable upload lifecycle. Do not edit backend feature declarations or UI.
- **Opus 5.5 High:** `packages/features`, `packages/ui`, `apps/web/src/index.css`. Own Emil-inspired visual components, feature-local consumption hooks, and state presentations. Develop against the public SDK, not raw fetch or independently invented contracts. Do not edit app root/routes/router or shared/root manifests.
- **Parent:** dependency installation/lockfile, app bootstrap and route mounts, environment/deployment configuration, editor integration validation, cross-layer integration, and final verification. Review delegates get read-only scope after known failures are addressed.

Each owner may create its package manifest. The parent alone runs workspace dependency installs and resolves shared-manifest changes.

## Stack and boundaries

Use Effect v3 with compatible `@effect/rpc` / `@effect/platform` (do not mix Effect v4). Registry versions found at kickoff: Effect current is v4, while RPC/platform are `0.76.2`/`0.97.2`; explicitly pin compatible Effect v3 rather than installing `effect@latest`.

`@hyori-cloud/lib` owns named third-party exports in explicit subpaths: `effect`, `react`, `query`, `icons`, `surreal`, and `storage` as needed. App/framework files are registered host boundaries. SDK root is vanilla; React integration lives at `@hyori-cloud/client-sdk/react`. Feature React screens live at `@hyori-cloud/features/react`. Existing shared shadcn components remain owned DS entry points. Keep private code behind package imports/export maps.

Feature APIs own their runtime schemas and operation metadata exactly once. Derive the SDK and Query catalogs from the composed Effect RPC declarations. Operation kind/invalidation annotations belong with declarations, not a parallel client operation list. Publish `@hyori-cloud/api/rpc` as client-safe declarations/codecs and `@hyori-cloud/api` as the server Fetch-handler factory. The API owner determines the wire implementation, documents it, and keeps SDK consumption schema-derived.

## Initial public consumption

The exact implementation must preserve this ergonomic surface (if a necessary correction is made, update this note and consumers at their owners):

```ts
const sdkClient = createClient({ baseUrl: "/api/rpc" });
await sdkClient.rpc.auth.status({});
await sdkClient.rpc.files.createFolder({ parentId: null, name: "Pictures" });

const queryClient = createQueryClient(); // app-owned, browser singleton / request-isolated SSR
setMutationDefaults(queryClient);

// In feature-local hooks:
const sdkClient = useClientSDK();
const listing = useQuery(sdkClient.query.files.list.getOptions({ parentId: null }));
const createFolder = useMutation(sdkClient.mutation.files.createFolder.mutationOptions());
```

Derive helper types (`InputOf`, `OutputOf`, `ResourceOf`) and result types from authoritative declarations. Root `createClient()` must work for non-React consumers without app internals. Its upload helper owns multipart/chunk sequencing, retries, cancellation, progress, and resume state—not UI hooks.

## First outcome, schemas, and operations

Complete protected bootstrap → login → browse/create folders → upload → download with real SurrealDB and RustFS before marking a vertical slice complete. Extend the same owners for remaining approved v1 features; report incomplete features rather than disguising placeholders as implemented editors.

Suggested schema fields below fix cross-owner expectations; runtime schemas at the owning API become the source of truth:

- `User`: `id`, `email`, `name`, `role` (`admin` / `user`), `quotaBytes`, `usedBytes`.
- `AuthStatus`: `initialized`, `user` (nullable). Unavailable persistence is an error, not an uninitialized instance.
- `FileEntry`: `id`, `name`, `kind` (`file` / `folder`), `parentId` (nullable), `ownerId`, `size`, `mimeType`, `createdAt`, `updatedAt`, `trashedAt` (nullable), and effective access/capabilities. Owner is not a fourth share role.
- File lists return `items`, `breadcrumbs`, `nextCursor`, and the authorized current folder; usage belongs in authenticated user/account state. File IDs are opaque strings, not trusted object-store keys.
- Sharing roles are exactly `viewer`, `contributor`, `editor`. Models/credentials/anonymous-link access must obey product decisions.
- Expected API failures use schema-defined stable codes/messages; preserve validation, denial, conflict, quota, and service-unavailable distinctions. Never return production mock success.

Initial operation namespaces:

- `auth.status`, `auth.setup`, `auth.login`, `auth.logout`, `auth.acceptInvite`. Setup takes `setupToken`, `email`, `name`, `password`; first-admin creation is atomic and one-time. Same-origin browser sessions use HttpOnly cookies; vanilla consumers can explicitly supply a credential-aware Fetch implementation.
- `files.list` (optional `parentId`, name search, type/date/size filters, cursor; `view` may describe data scope, not select backend implementations), `files.createFolder`, `files.rename`, `files.move`, `files.trash`, `files.restore`, `files.versions`, `files.restoreVersion`, and authorized download/preview capability.
- `uploads.begin`, `uploads.status`, `uploads.part`, `uploads.complete`, `uploads.abort`; actual binary transfer may use an owned HTTP capability outside JSON RPC. A resumable upload must recheck authorization and quota on completion and preserve old committed content on failure.
- `shares.list`, `shares.create`, `shares.revoke`, `shares.resolve`, `shares.unlock`; account-specific and public roles, inherited access, optional passwords/expiry/revocation.
- `admin.users`, `admin.createUser`, `admin.createInvite`, `admin.setQuota`, `admin.deleteUser`. No admin file browsing; account deletion is a separate explicit operation.
- `photos.sources`, `photos.setSources`, `photos.timeline`, `photos.albums`, `photos.createAlbum`, `photos.addToAlbum` over existing file IDs and current permissions.

Backend/SDK owners may choose precise operation payload details at the schema owner. Publish those before consumers finalize call sites. Do not create a second handwritten method mirror to resolve disagreement.

## React composition and state ownership

```text
app RootDocument (document markup, stylesheet, metadata)
  app Providers (one SDK instance + one shared browser QueryClient)
    QueryClientProvider
      ClientSDKProvider
        CloudScreen
          AuthBoundary (setup / login / authenticated / service failure)
          CloudShell (sidebar, main content, account menu)
            FilesScreen / PhotosScreen / SharedScreen / TrashScreen / AdminScreen
              feature-local query/mutation hooks
              DS pending / error / empty / content presentations
```

App bootstrap and API mounts remain app-owned; do not create `features/app`. SDK context is not Query cache ownership. Portable UI components and hooks have no effects or raw transports. Keep existing data visible during refresh errors. Controlled drafts/selection remain React state; server entities remain Query data. Use explicit semantic states and exhaustive handling rather than a universal status wrapper.

`vercel-composition-patterns` is unavailable in this session; use Fernando's self-contained React reference and report that limitation. UI owner must read `emil-design-eng`. Compile new React with React Compiler and run its diagnostics.

## Verification

- Real-service integration tests: bootstrap races/auth, user isolation, file lifecycle, actual stored bytes, rejected writes, quota and sharing rules as delivered.
- SDK non-React lifecycle consumer plus derived Query compile/cache/evolution fixtures.
- Adopt the executable Fernando lint profile with explicit roles and real fixtures; preserve Oxlint/Oxfmt. No no-op gate commands.
- React Doctor is required for UI. Use the installed/pinned CLI with noninteractive mode and `--no-score` so source/findings are not sent to scoring/sharing/crash services. Verify actual CLI flags before use. Do not auto-install agent skills or workflows.
- Build, types, tests, architecture lint, and React Doctor must be reported separately. Passing a build is not proof that every approved v1 feature or external editor works.

## SDK/declaration handshake — 2026-11-04

- Feature-owned `operations` tuples contain each Effect `Rpc.make(...)` declaration plus literal `kind`, optional `invalidates` namespace prefixes, and optional `resetCache`. The composed `ApiRpc` group and all SDK trees derive from those same tuples. Context annotations alone do not retain literal operation-kind information in the Effect RPC type, so the typed tuple is intentional, not a second client registry.
- The Fetch wire is JSON `POST /api/rpc`: `{ operation: "files.list", input: { ... } }`; response `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. SDK input encoding/result/error decoding use the operation's authoritative schemas. The server-safe API root is not imported by the client; runtime codecs/declarations come from `@hyori-cloud/api/rpc`.
- `@hyori-cloud/lib/query-core` owns framework-independent TanStack core types/primitives. SDK root runtime and declarations do not require React. The SDK owns a shared internal declaration-derived mutation policy; its optional React entry exports the single mutation-default installer alongside provider, resource projections, and subscriptions. `ClientSDKProvider` accepts `sdkClient={sdkClient}` and does not manufacture a QueryClient.
- Upload status includes `uploadId`, `chunkSize`, `totalParts`, acknowledged `{ partNumber, size }` entries, `state` and nullable `fileId`. `uploads.part` returns an authorized app-relative PUT capability and is a read-safe query; binary PUT rechecks authorization. Chunk count is `max(1, ceil(size / chunkSize))`, including empty files. Backend chunk size is 8 MiB, bounded to 10,000 parts; SDK rejects invalid geometry or chunks over 64 MiB.
- `uploads.complete` must idempotently return the already committed file after an ambiguous response while rechecking current authorization. The SDK never automatically replays begin/complete. A lost begin response cannot recover an unknown upload ID; backend seven-day retention/maintenance owns cleanup of that reservation. Part retries reacquire capabilities and resend only that numbered part.
- SDK upload progress means acknowledged bytes, not socket-level progress. Pause retains a resumable checkpoint; `cancelling` is nonterminal and retains metadata until authoritative backend confirmation. A failed cancellation carries `intent: "cancel"`, and retry reattempts cancellation rather than resuming transfer. Once completion starts, the task exposes `finalizing` and local pause/cancel waits for the authoritative commit outcome rather than pretending a committed file can be retracted. Reload resume requires metadata decoding, local file reselection and `confirmSameFile: true`; matching metadata cannot prove byte identity. Hosts persist metadata only, never unrestricted local file access.
- `uploadMutationOptions(sdkClient, options)` binds one vanilla lifecycle to the derived `uploads.complete` mutation key. Multi-file UI uses `createQueryUploadQueue(sdkClient, queryClient, hostStore)` from SDK React: the vanilla queue owns bounded admission, retry/resume and checkpoint retention; its React adapter invokes the same declaration-derived completion policy as mutation defaults. UI calls queue actions and observes `useUploadEntries`/`useUploadSummary`; it maintains neither an upload algorithm nor a second invalidation registry. Host storage is a narrow injected synchronous `read`/`write` capability. A known begin response arriving after queue disposal merges its checkpoint into current storage without retaining UI observers; successor writes preserve those newly discovered IDs. Restored-checkpoint cancellation is serialized against reselection and publishes its pending state. This is not a cross-tab storage lock. `downloads.open` returns metadata plus a readable stream for a host-owned sink.
- SDK and Query acceptance fixtures use an explicit fake API/storage with real public SDK, TanStack primitives and mounted SDK/Query providers. `check:app-runtime` separately mounts the actual generated TanStack route tree, document root and provider composition, decorates existing product route content with two diagnostic consumers, and drives folder creation plus real router navigation. It checks shared SDK/cache identity, identical-read deduplication, declaration-owned cross-feature invalidation and retained browser instances; a separate non-DOM process checks actual server router request isolation. Only the stylesheet URL is adapted for Bun; no application modules/providers are mocked. The mounted host is JSDOM over scripted HTTP, not proof of browser hydration, layout, touch, assistive technology or real-service durability. Packed-artifact consumption and measured performance remain separate gates.

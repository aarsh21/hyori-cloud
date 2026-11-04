# Hyori Cloud

A self-hosted home for files, photos, and documents, built with React, TanStack Start, SurrealDB, RustFS, shadcn/ui, and Tailwind CSS.

**Implementation is in progress, not a completed production-ready v1.** The working core includes protected setup/login, file/folder operations, resumable uploads, downloads, sharing, trash, personal photo sources/albums, and quota/account administration. Version creation through replacement and history/restore work through the public API, but uploading a replacement/new version is not yet exposed in the web interface; uploading a duplicate name is rejected, not treated as replacement. The web interface consumes the same public SDK as non-React clients. ArtCraft document editing, derived thumbnails, and several operational lifecycle features remain unfinished. See [backend limits](packages/api/README.md), [ArtCraft findings](docs/artcraft-integration.md), and the [product scope](docs/product.md).

## Local development

Requirements: **Bun 1.4.4**, Node 24+, Docker with Compose, and free loopback ports 3001, 8000, and 9000. Bun 1.3.5 exhibited a dependency-resolution hang and a streamed Blob-slice sizing bug during integration; the runtime, Docker build, and CI are pinned to 1.4.4.

```sh
bun install
```

Create `apps/web/.env` from [the example](apps/web/.env.example), or edit that file if it already exists. Replace **all** placeholder secrets with separate strong values:

- `HYORI_SETUP_TOKEN`: a private operator token, at least 24 characters, used only for initial admin creation.
- `SURREALDB_PASSWORD`: the database service credential.
- `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY`: private object-store credentials.

Keep these values out of source control. Example placeholders are deliberately rejected by the application; they are not development credentials. The default URLs target loopback services and `APP_ORIGIN=http://localhost:3001` for local development.

```sh
bun run services:up
bun run dev:web
```

Open http://localhost:3001. Enter the setup token and create the first admin with an email and password. Subsequent users are created by an admin or admitted through invite links; public registration is disabled. Email verification, PINs, and SSO are not part of v1.

The Docker services run as their image-defined non-root users. A narrowly scoped initialization container assigns ownership of the named data volumes; `nocopy` mounts preserve that ownership. Database and object-store ports bind only to loopback. Do not expose those credentials or ports publicly.

## Architecture and source ownership

Follow [AGENTS.md](AGENTS.md). The implementation uses feature-owned Effect v3 schemas/RPC declarations, a composed authorized API, a schema-derived vanilla SDK and Query integration, and portable UI features. The JSON wire is documented in [the API README](packages/api/README.md); it is not Effect's built-in NDJSON transport.

```text
apps/web                 TanStack routes, document shell, providers, environment, API host
packages/core            Feature schemas, operations, authorization, services and persistence
packages/api             Composed Fetch handler and client-safe RPC declarations
packages/client-sdk      Vanilla public client, upload lifecycle, derived Query/React adapters
packages/features        Product UI and feature-local state/data consumption
packages/ui              Shared shadcn/design-system primitives and presentation
packages/lib             Owned Effect, React/Query, crypto, SurrealDB and RustFS adapters
tooling/architecture     Actual project roles, graph checks and acceptance fixtures
tooling/fernando-lint    Vendored executable lint profile and its regression tests
tooling/anti-slop        Pinned generic/Effect Oxlint rules, provenance and regression suites
```

One browser QueryClient is shared across features; server requests receive isolated caches. The application owns SDK/provider lifetime. Upload sequencing, retry, checkpoints, and queue policy belong to the vanilla SDK; browser storage and subscriptions live in registered host adapters.

The authorized API is hosted at `/api/rpc`; binary transfers use `/api/storage/*`. Deep file, share, invite, photo and admin locations are handled by the web router. Users must reselect their source file when resuming an interrupted upload after losing browser file access.

## Shared UI

Shared primitives live in `packages/ui`; tokens and global styles live in `packages/ui/src/styles/globals.css`. Add shadcn primitives to that package:

```sh
npx shadcn@latest add dialog popover sheet -c packages/ui
```

[DESIGN.md](DESIGN.md) defines the visual language. The [pinned upstream skills](.agents/skills/UPSTREAM.md) `design-taste-frontend-v2-experimental` and `brandkit` guide taste and brand imagery. Product features consume owned DS exports, not raw transport or server implementations. Emil-inspired polish includes keyboard interactions and explicit loading, empty, failure, and retained-data states; decorative motion must not delay frequent actions.

The desktop sidebar collapses from its toggle or with Ctrl/Cmd+B, and this browser remembers the choice. Phones use the bottom navigation.

Appearance defaults to **System**. Choose **Light**, **Dark**, or **System** in the account menu, or use **Appearance** below sign-in/setup/invite/public-link forms (in the toolbar for an opened shared folder). Choices persist locally in this browser, not on the account. The app root mounts the owned `@hyori-cloud/ui/theme` adapter once; its pre-paint script applies the saved or system scheme before content, and native controls and toasts follow the resolved appearance. Theme changes are immediate, without page-wide color animations.

## Environment

The application owns `.env.schema`. Varlock generates the ignored `apps/web/src/env.ts` accessor during installation; run `bun run env:generate` after schema changes. Application code uses `ENV`; packages receive initialized configuration from their host.

Secrets are optional during asset compilation but required when the API is initialized. A missing configuration or unavailable backend returns a real service failure, never a mock library or an uninitialized-instance success. Bun's automatic environment loading remains disabled in `bunfig.toml`; the Varlock integration loads the app schema.

## Deployment

For production set `APP_ENV=production` and `APP_ORIGIN` to the exact external **HTTPS** origin and terminate TLS through a trusted reverse proxy. `APP_ENV` controls runtime application policy; it is separate from the framework's `NODE_ENV` build mode. Builds explicitly use `NODE_ENV=production`, while deployment-specific settings resolve at startup rather than being baked into SSR artifacts. Preserve the original request host/protocol, and sanitize forwarded headers. Production sessions require HTTPS; the development HTTP origin is not a production deployment recipe.

```sh
bun run docker:build
bun run docker:up
bun run docker:logs
bun run docker:down
```

Compose reads `apps/web/.env`, replaces container-internal service URLs, and uses persistent named volumes. The web port binds to loopback for a reverse proxy. Builds do not bake secret env files into image layers. `docker:down` does not remove persistent volumes.

The web host starts a non-overlapping maintenance sweep every minute after API initialization, with lifecycle cleanup. It clears abandoned uploads/reservations, expired credentials and pending account purges in bounded batches. Generic API consumers hosting `createHandler` themselves must schedule its `.maintenance()` and call `.dispose()` on teardown. Monitor maintenance failures and retain backups of **both** metadata and object storage. Trash and version history are not backups.

The initial target remains 2 CPU cores / 4 GB total host RAM. Detailed resource tuning and capacity benchmarks are deferred; no measured capacity guarantee is claimed.

## Verification

```sh
bun run check:quality       # Post-change anti-slop, React Doctor, and TypeScript-only source gates
bun run check               # Oxlint/Oxfmt checks and workspace types/build
bun run lint:anti-slop      # Local generic + Effect rules; run after every change, warnings fail
bun run test:anti-slop      # Vendored regressions, exact versions and real Vite+ acceptance probes
bun run check:tooling-types # Strict tooling/plugin TypeScript, including converted architecture/PostCSS files
bun run check:scripts-types # Typecheck actual startup, service-integration, and local-setup scripts
bun run check:source-files  # Reject authored .js/.jsx/.mjs/.cjs; preserve generated and vendored files
bun run test                # Unit, SDK/Query, and feature tests (live API suite explicitly skips without test endpoints)
bun run test:services       # Real DB/storage, SDK restart durability and built HTTP routes; Docker + web build required
bun run test:architecture   # Vendored checker regressions plus actual owned-facade regressions
bun run check:boundaries    # Public exports, dependency direction and vanilla/client-safe graphs
bun run check:query         # Public SDK compile, behavior, second-client and evolution fixtures
bun run check:artifacts     # Offline external packed SDK consumers, with/without optional React peers
bun run check:app-runtime   # Actual app-owned runtime/cache/provider composition fixtures
bun run lint:architecture  # Registered feature/DS/host rules and React Compiler diagnostics
bun run ui:doctor           # Local React Doctor; no remote scoring or Socket dependency scan
bun run check:web           # Bounded web build and dev HTTP-readiness check
bun run check:dev-server    # Isolated Nitro request cancellation and real HMR error delivery
```

Install the locked architecture-tool dependencies before its checks:

```sh
npm --prefix tooling/fernando-lint ci
```

Oxlint/Oxfmt remain the primary lint/format tools. The focused Fernando ESLint profile and React Hooks compiler diagnostics supplement them; broader architecture claims still require code review and behavioral evidence. React Compiler is enabled in the actual Vite build via `reactCompilerPreset`.

[Anti-slop provenance](tooling/anti-slop/UPSTREAM.md) records the manually copied MIT source, pinned revision and local adaptations. All generic and Effect rules are enabled in the shared Vite+ lint config, with exact matching Oxlint/plugin versions. Run the local command after every change; CI also runs it and the plugin regressions. Findings are real failures, not an indication that product behavior or architecture has been verified. Handwritten architecture and PostCSS tooling is TypeScript; vendored checker JavaScript, dependencies, and generated artifacts retain their original formats.

[doctor.config.json](doctor.config.json) scopes React Doctor to source projects and excludes generated `.output`, route, and environment artifacts—not source rules. The pinned local CLI disables scoring/crash reporting and the separate Socket.dev supply-chain scan. Do not run its automatic skill/hook installer as part of verification.

`check:app-runtime` mounts the actual document/root providers and generated TanStack route tree in JSDOM over scripted HTTP. It verifies two consumers share SDK/cache identity and one identical read, a real folder-creation action invalidates Files/Photos queries, actual Files → Photos → Files navigation retains the browser runtime/cache, and separate server routers own isolated runtimes. Only stylesheet-URL loading is adapted; application modules and providers are not mocked. Appearance fixtures additionally exercise Light/Dark/System controls, persistence/remount, live OS/storage changes, keyboard focus, and existing toasts. A separate process renders the appearance provider without browser globals; its actual bootstrap script runs before JSDOM hydration with no recoverable or logged hydration errors for each saved preference and the default. Tests read the actual CSS palettes to check selected text/button/focus contrast pairs. This is not a real-browser hydration, rendered visual, touch or assistive-technology audit.

The web readiness gate proves an HTTP 200, not browser hydration. `check:artifacts` packs SDK/API/core/lib and runs strict external vanilla and React consumers offline without workspace aliases or symlinks. Its supported direct source-artifact runtime is Bun 1.4.4 with the TypeScript consumer configuration documented in [the SDK README](packages/client-sdk/README.md#local-artifact-contract); it does not establish direct Node or universal bundler compatibility. SDK fixtures using a fake transport are labeled separately from `test:services`, which starts unique loopback-only containers and test volumes and removes those test resources afterward. See `tooling/web-gates.json` for timing conditions; these are CI safety limits, not user-facing performance benchmarks.

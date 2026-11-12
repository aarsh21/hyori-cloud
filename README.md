# Hyori Cloud

A self-hosted home for files, photos, and documents, using React, TanStack Start, a Rust/PostgreSQL backend with Better Auth Rust, RustFS, shadcn/ui, and Tailwind CSS. The active web host now proxies to Rust; the legacy TypeScript/SurrealDB server is retired. **No existing deployment data has been deleted or automatically migrated.** See [rewrite acceptance](docs/rust-rewrite.md) and [retirement/coverage](docs/legacy-backend-retirement.md).

**Implementation is in progress, not a completed production-ready v1.** Rust covers protected setup/login, files/folders, resumable transfers, sharing, trash/version history, personal photo sources/albums, safe original previews and quota/account administration. The actual built Nitro host has public-SDK HTTP/TLS-termination acceptance over real PostgreSQL/RustFS. Isolated thumbnail/poster processing and its UI presentations are implemented, with paired real-worker browser acceptance still open. Editor persistence has real-service SDK coverage but remains disabled pending actual WASM/cloud integration, redistribution gates and UI completion. Whole-product acceptance and operational work are unfinished. See [rewrite acceptance](docs/rust-rewrite.md).

The web interface exposes explicit new-version uploads with confirmation, progress, pause, retry, cancel and checkpoint/reselection recovery through the same public SDK as non-React clients. Picking or dropping a duplicate filename never silently replaces a file. Mounted UI tests and real Rust/PostgreSQL/RustFS SDK/release-container replacement tests pass separately; the composed Rust web flow still needs real-browser acceptance.

ArtCraft editing, composed real-worker browser acceptance and several operational lifecycle features are unfinished. See [backend limits](packages/api/README.md), [ArtCraft findings](docs/artcraft-integration.md), and the [product scope](docs/product.md).

## Local development

Requirements: **Bun 1.4.4**, Node 24+, Docker with Compose, and an unused loopback web/backend port for native development. Bun 1.3.5 exhibited a dependency-resolution hang and a streamed Blob-slice sizing bug during integration; the runtime, Docker build, and CI are pinned to 1.4.4.

```sh
bun install
```

Create a **new** `apps/web/.env` from [the web example](apps/web/.env.example), or edit the existing file explicitly without overwriting it. The web host needs only `APP_ENV`, exact public `APP_ORIGIN`, and private `HYORI_BACKEND_URL`; it must not receive database, setup, auth or object-store credentials. Point the backend URL at your separately configured Rust service on an unused port (the example uses 3003; do not assume 3002 is free).

For native Rust development, start PostgreSQL/RustFS in isolated operator-managed services, configure Rust privately from [its example](apps/server/.env.example), override `HYORI_SERVER_BIND` to the unused backend port, and run the Rust server with that explicit environment. A real setup token (24–256 Unicode characters), independent auth secret, dedicated PostgreSQL URL and all five storage values belong **only** to Rust. Example credential placeholders are intentionally rejected; there are no ambient AWS credentials or automatic data migration. For a fresh Compose stack instead, follow Deployment below; DB/storage/backend ports are private there, not published for native clients.

```sh
bun run dev:web
```

Open http://localhost:3001. Enter the setup token and create the first admin with an email and password. Subsequent users are created by an admin or admitted through invite links; public registration is disabled. Email verification, PINs, and SSO are not part of v1.

Password change and administrator-issued one-time password reset are implemented in the Rust API and generated SDK, but their account/Users interfaces are not yet implemented. Reset links last 24 hours and must be passed on privately; Hyori sends no email. Individual session management and recovery for a sole administrator are still missing. See [the password operation contract](packages/api/README.md#password-change-and-administrator-recovery).

The fresh Compose stack keeps PostgreSQL, RustFS and Rust ports private. A narrowly scoped initialization container assigns ownership only to the **new** Rust storage volumes; `nocopy` mounts preserve that ownership. It does not touch any legacy volumes. Do not expose service credentials or private ports publicly.

## Architecture and source ownership

Follow [AGENTS.md](AGENTS.md). Rust feature APIs own wire schemas and operation metadata. Generated Effect codecs/RPC declarations feed the existing inferred vanilla SDK and Query integration; Effect remains client runtime infrastructure, not a second backend. The JSON wire and owned streaming host are documented in [the API README](packages/api/README.md); this is not Effect's built-in NDJSON transport.

```text
apps/web                 TanStack routes, document shell, providers, environment, API host
apps/server              Rust feature APIs, authorization, PostgreSQL persistence and maintenance
apps/media-worker        Credential-free, network-isolated thumbnail/poster decoder over a private socket
crates/storage           Owned RustFS streaming/storage adapter
packages/api             Generated client codecs/RPC and generic/Node streaming proxy entries
packages/client-sdk      Vanilla public client, upload lifecycle, derived Query/React adapters
packages/features        Product UI and feature-local state/data consumption
packages/ui              Shared shadcn/design-system primitives and presentation
packages/lib             Owned client-safe Effect, React/Query and icon facades
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

The desktop sidebar collapses from its toggle or with Ctrl/Cmd+B, and this browser remembers the choice. Phones use the bottom navigation. **Single-key shortcuts** in the account menu (also available in public folders) controls `/`, `n`, and `u` locally. Larger loaded collections use bounded rendering above 200 items; browser find-in-page cannot search unmounted rows, so use the product search field to find files.

Appearance defaults to **System**. Choose **Light**, **Dark**, or **System** in the account menu, or use **Appearance** below sign-in/setup/invite/public-link forms (in the toolbar for an opened shared folder). Choices persist locally in this browser, not on the account. The app root mounts the owned `@hyori-cloud/ui/theme` adapter once; its pre-paint script applies the saved or system scheme before content, and native controls and toasts follow the resolved appearance. Theme changes are immediate, without page-wide color animations.

## Environment

The application owns `.env.schema`. Explicit Varlock codegen generates the ignored `apps/web/src/env.ts` accessor during installation; run `bun run env:generate` after schema changes. Automatic runtime codegen is disabled (`auto=false`) so the production filesystem can remain read-only. Application code uses `ENV`; packages receive initialized configuration from their host.

No backend secrets are needed for web compilation or runtime. The app resolves public origin/private backend configuration once and returns a noncached 503 on missing/unsafe configuration or backend connection failure, never mock success. `HYORI_BACKEND_URL` is sensitive/dynamic so it is absent from HTML/client hydration. Bun's automatic environment loading remains disabled in `bunfig.toml`; Varlock loads the app schema. The standalone web image contains the schema and minimal Varlock/React runtime support, never actual `.env` files or workspace server credentials.

## Deployment

For production set `APP_ENV=production` and `APP_ORIGIN` to the exact external **HTTPS** origin and terminate TLS through a trusted reverse proxy. `APP_ENV` controls runtime application policy; it is separate from the framework's `NODE_ENV` build mode. Builds explicitly use `NODE_ENV=production`, while deployment-specific settings resolve at startup rather than being baked into SSR artifacts. Preserve the original request host/protocol, and sanitize forwarded headers. Production sessions require HTTPS; the development HTTP origin is not a production deployment recipe.

```sh
bun run docker:build
bun run docker:up
bun run docker:logs
bun run docker:down
```

First create a **new** ignored `.env.deployment` from [.env.deployment.example](.env.deployment.example) and privately replace every rejected credential placeholder. Root Docker commands read this file, not any existing web or production environment. The default Compose project is **hyori-cloud-rust** with new dedicated PostgreSQL and RustFS data/log volumes. It is a **fresh instance**, not an in-place upgrade or importer: no legacy accounts, DB, objects, volumes or containers are deleted, adopted or migrated. Do not override the project to the old stack, reuse its volumes, run `down -v`, `--remove-orphans` or prune data. Existing deployments require a separate migration/cutover decision and backups. No migration tool is provided.

Compose publishes only the loopback web port (`HYORI_WEB_PORT`, default 3001), behind your HTTPS gateway; DB/storage/Rust ports have no host bindings. The gateway must preserve the exact configured public **Host** on its private HTTP hop and sanitize forwarded headers. The web host validates Host and Origin instead of trusting `X-Forwarded-*`, then the Node transport preserves configured public authority toward Rust. Do not disable TLS/origin checks. This documentation does not install or reconfigure a gateway or expose a final LAN service. Builds exclude actual env files from image layers; `docker:down` stops only this new project and does not remove its volumes.

Rust owns auth/upload/media/account-purge maintenance and shutdown. The backend's Compose stop grace is 150 seconds so its existing transfer admission can drain disconnect-safe leased writes (125-second operation plus bounded release) before the database closes; do not override it with Docker's short default when orderly write completion is required. A forced kill or infrastructure failure still relies on durable reconciliation/lease expiry. The web host has no domain maintenance timer or privileged maintenance endpoint. Compose includes a separate nonroot media worker with no network, no backend credentials, a read-only root, bounded CPU/memory/PIDs and scratch tmpfs. It shares only a dedicated mode-0700 socket volume; the backend mounts that volume read-only. A separate narrowly privileged initializer touches only this new socket volume. The worker fails closed without its required Linux/cgroup-v2 isolation; see [worker budgets, supported inputs, cache retention and licensing limits](apps/media-worker/README.md). Rendered configuration checks are not actual decoder/browser or complete Compose deployment acceptance. Monitor worker failures and retain backups of **both** metadata and object storage. Trash and version history are not backups.

Editor runtimes require an explicit immutable-bundle opt-in and matching same-origin static delivery; see [editor deployment](docs/editor-deployment.md). The base stack does not enable them, and the overlay does not prove real editor/browser acceptance.

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
bun run test                # Client/unit/host regressions; no silently skipped legacy live suite
bun run test:node-proxy     # Native Node HTTP streaming/cookies/Host/cancellation
bun run test:web-image hyori-web-local # Minimal read-only frontend image packaging (build image first)
bun run test:deployment     # Render Compose with synthetic config; assert private ports/decoder isolation
bun run test:services       # Real Rust service gate + six public-SDK harnesses; decoder fixture image required
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

Rust and cross-language architecture checks also require the repository-pinned Rust toolchain, native ICU/OpenSSL development libraries, pkg-config and Clang. On Debian/Ubuntu, install `libicu-dev libssl-dev pkg-config clang`; build scripts derive the installed ICU major rather than assuming this machine's version. Prepare the exact Cargo graph before running the offline evolution fixture:

```sh
rustup show active-toolchain
bun run rust:prepare
bun run contracts:check
bun run check:rust
docker build -f apps/media-worker/Dockerfile -t hyori-media-worker:local .
export HYORI_MEDIA_TEST_IMAGE=hyori-media-worker:local
export RUST_TEST_THREADS=1 # Bound simultaneous PostgreSQL/RustFS/decoder fixtures
bun run test:rust-services # Explicit real PostgreSQL/RustFS/isolated-worker fixtures
bun run test:rust-media-sdk # Actual public SDK media lifecycle, recovery and purge
bun run test:rust-sdk      # actual Rust -> web proxy -> public vanilla SDK
# Build locally; no registry publication:
docker build -f apps/server/Dockerfile -t hyori-rust-local .
bun run test:rust-image hyori-rust-local
bun run --cwd apps/web build
bun run test:rust-web-host hyori-rust-local # Actual built Nitro, TLS termination, public SDK, real services
```

The evolution fixture is a workspace example and uses the same `Cargo.lock`, not a temporary package resolved from whichever versions happen to be cached. CI installs these prerequisites and fetches the locked graph before its offline Query gate. Ordinary Rust tests explicitly skip Docker fixtures; their real-service command is separate. Rust checks default to two build jobs and disable test-profile debug symbols to bound CI build resources, not to bypass tests or validation.

The release-image acceptance harness creates its own private Docker network and PostgreSQL container, runs the server with a read-only root as UID 10001 with capabilities dropped, and drives real production-cookie setup/files/logout and restart persistence through the public SDK/proxy. It removes only its own test containers, volumes and network. This proves the exercised image/runtime slice, not TLS termination, browser behavior or complete product delivery. A separate CI job builds and exercises the image without publishing it; remote CI results remain unverified until that job runs.

Oxlint/Oxfmt remain the primary lint/format tools. The focused Fernando ESLint profile and React Hooks compiler diagnostics supplement them; broader architecture claims still require code review and behavioral evidence. React Compiler is enabled in the actual Vite build via `reactCompilerPreset`.

[Anti-slop provenance](tooling/anti-slop/UPSTREAM.md) records the manually copied MIT source, pinned revision and local adaptations. All generic and Effect rules are enabled in the shared Vite+ lint config, with exact matching Oxlint/plugin versions. Run the local command after every change; CI also runs it and the plugin regressions. Findings are real failures, not an indication that product behavior or architecture has been verified. Handwritten architecture and PostCSS tooling is TypeScript; vendored checker JavaScript, dependencies, and generated artifacts retain their original formats.

[doctor.config.json](doctor.config.json) scopes React Doctor to source projects and excludes generated `.output`, route, and environment artifacts—not source rules. The pinned local CLI disables scoring/crash reporting and the separate Socket.dev supply-chain scan. Do not run its automatic skill/hook installer as part of verification.

`check:app-runtime` mounts the actual document/root providers and generated TanStack route tree in JSDOM over scripted HTTP. It verifies two consumers share SDK/cache identity and one identical read, a real folder-creation action invalidates Files/Photos queries, actual Files → Photos → Files navigation retains the browser runtime/cache, and separate server routers own isolated runtimes. Only stylesheet-URL loading is adapted; application modules and providers are not mocked. Appearance fixtures additionally exercise Light/Dark/System controls, persistence/remount, live OS/storage changes, keyboard focus, and existing toasts. A separate process renders the appearance provider without browser globals; its actual bootstrap script runs before JSDOM hydration with no recoverable or logged hydration errors for each saved preference and the default. Tests read the actual CSS palettes to check selected text/button/focus contrast pairs. This is not a real-browser hydration, rendered visual, touch or assistive-technology audit.

The web readiness gate proves an HTTP 200, not browser hydration. `check:artifacts` packs exactly SDK/API/lib (and rejects any legacy core artifact) and runs strict external vanilla and React consumers offline without workspace aliases or symlinks. Its supported direct source-artifact runtime is Bun 1.4.4 with the TypeScript consumer configuration documented in [the SDK README](packages/client-sdk/README.md#local-artifact-contract); it does not establish direct Node or universal bundler compatibility. SDK fixtures using a fake transport are labeled separately from the real-service gates, which use unique loopback/private containers and disposable resources and remove only their own fixtures afterward. `test:rust-web-host` additionally verifies disposable-certificate HTTPS → actual Nitro → Rust with no browser API bypass or global TLS disable. CI's Rust and image jobs own these expensive gates once; the general verify job does not rerun a legacy service gate. See `tooling/web-gates.json` for timing conditions; these are CI safety limits, not user-facing performance benchmarks.

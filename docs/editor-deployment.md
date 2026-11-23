# Opt-in editor runtime deployment

This is the deployment contract, not evidence that all four editors have passed cloud acceptance. See [current integration evidence](artcraft-integration.md) and [server persistence and runtime verification](editor-persistence.md). A static bundle, a synthetic persistence fixture, a frame-level probe, and a real browser/backend round trip prove different things. Never deploy the synthetic fixtures or historical modified Deck `.1` build.

## One immutable bundle, two read-only mounts

Acquire/build the supported runtime using the ArtCraft tooling and retain its exact receipt, source availability, notices and external manifest SHA-256. Use the final verified bundle directory, not an acquisition workspace or build cache. Keep files mode `0444` and directories mode `0555`, and make their parent directories traversable by the unprivileged container users. The backend rejects writable files/directories, symlinks, extras, missing files and hash/version mismatches. Mount the **same** bundle read-only in both the backend and your HTTPS gateway; do not copy or modify it after verification.

The optional [Compose overlay](../docker-compose.editors.yml) adds no service, port, credential or persistent volume. Set these operator values privately in the deployment configuration:

- `HYORI_EDITOR_ASSETS_DIR`: absolute host path to the verified immutable runtime root.
- `HYORI_EDITOR_ASSETS_MANIFEST_SHA256`: the receipt's exact SHA-256 for `runtime-bundle-manifest.json`.

Explicitly include the overlay with the same project name and configuration as your existing Rust stack:

```sh
docker compose --env-file .env.deployment \
  --file docker-compose.yml --file docker-compose.editors.yml \
  up -d --build backend web
```

The overlay maps the host directory to `/opt/hyori/artcraft` and supplies that container path to Rust. It refuses to create a missing host directory. The base Compose file deliberately leaves editors unconfigured. Never rename an existing project, reset its database, recreate its storage volumes, or run volume-removal commands to enable editors. This recipe does not migrate the retired legacy deployment.

Rust verifies the manifest and inventory before connecting to the database. The additive runtime migration preserves existing data. First verified activation can enable an exact supported app/version; later restarts preserve a deliberate database disable switch. Missing runtime configuration denies old sessions too. Do not replace this mechanism with arbitrary `enabled=true` SQL.

## Same-origin static delivery

The gateway must serve `/artcraft/*` before its ordinary web reverse proxy, from the matching read-only mount. Do not strip another path level, redirect to an external asset origin, rewrite relative JS/WASM/snippet paths, or cache errors as successful assets. The authorized `EditorDocument.assetUrl` selects the editor entry; consumers use it verbatim.

Test a script from the editor's Network panel without a session cookie and with `Origin: null`. It must return JavaScript, HTTP 200 and `Access-Control-Allow-Origin: *`. A private preview portal that requires its own sign-in for every request can return 401 before Hyori sees the request. Changing Hyori's CSP won't fix that. Use a gateway that serves the verified, read-only runtime assets without a portal cookie; keep Hyori's files, API and sessions protected. Do not add `allow-same-origin` to the frame.

For Caddy, mount the bundle at `/srv/artcraft` and place this handler **inside your existing HTTPS site**, ahead of a fallback `handle` containing your existing `reverse_proxy`. Keep your actual certificate, hostname, port and host/forwarded-header policy unchanged.

The Content-Security-Policy line depends on the exact bundle. Each editor's index page runs one inline loader `<script>` and carries one inline `<style>`, and their hashes change with every build. Print the line for the bundle and receipt you are deploying, and paste it where the handler below has its placeholder. This example uses r5; for a different bundle, use its own receipt:

```sh
bun scripts/editor-csp.ts /path/to/verified/runtime-bundle tooling/artcraft/runtime-all4-native-v3-r5.json
```

The command reads each editor's index page through the bundle's `runtime-bundle-manifest.json` and hashes the inline loader and style. It fails unless the receipt's `manifestSha256` matches the bundle and its `editors[].cspScriptHashes` match the loaders exactly. `'wasm-unsafe-eval'` allows WebAssembly compilation, not JavaScript `eval`. Print the line again whenever you change the bundle: a stale line blocks the new loaders, and the editors never get past their loading text.

The frame policy restricts resource loading to its own origin, with local image and print exceptions:

| Directive         | Sources and reason                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox`         | `allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads`, the host frame's exact tokens: every page under `/artcraft` runs in an opaque origin, however it is reached (framed, opened as a popup, followed from a link or typed in). Without it, an editor page opened outside the frame ran with Hyori's origin and the person's session. |
| `default-src`     | `'self'`: deny external resource hosts, including fonts, media and workers not otherwise listed. The receipts inventory sibling JavaScript, WASM, snippet modules and icons; fonts are embedded in WASM.                                                                                                                                                                   |
| `connect-src`     | `'self'`: the loader fetches sibling WASM; the bridge transfers document bytes through same-origin parent messages, not external services. No remote API, telemetry, WebSocket or CDN is required by that contract.                                                                                                                                                        |
| `img-src`         | `'self' blob: data:`: local icons and in-memory document/print images. These exceptions do not allow an external image host.                                                                                                                                                                                                                                               |
| `frame-src`       | `'self' blob:`: upstream Word and Grid `print_pdf` load a generated PDF into a child iframe. Hosted print downloads the PDF instead, because a sandboxed page can't show one; the directive is kept for the unhosted path.                                                                                                                                                 |
| `form-action`     | `'none'`: document operations use the host bridge, not form submissions. This directive does not inherit `default-src`.                                                                                                                                                                                                                                                    |
| `frame-ancestors` | `'self'`: only the same-origin Hyori host may embed an editor.                                                                                                                                                                                                                                                                                                             |
| `object-src`      | `'none'`: no plugin/object embedding; print uses an iframe.                                                                                                                                                                                                                                                                                                                |
| `base-uri`        | `'self'`: keep relative loader paths on the editor origin.                                                                                                                                                                                                                                                                                                                 |
| `script-src`      | `'self' 'wasm-unsafe-eval'` plus exact loader hashes: sibling glue and snippet imports, WebAssembly compilation and Trunk's inline module loader. No JavaScript `eval`, arbitrary inline script or remote script host.                                                                                                                                                     |
| `style-src`       | `'self'` plus exact inline style hashes: the entry page's canvas and loading layout. No arbitrary inline style allowance is added.                                                                                                                                                                                                                                         |

This policy is source-derived, not real-editor acceptance evidence. Before rollout, on the machine with the trusted bundle, regenerate the header and test all four editors: cold and cached load, WASM compilation, embedded fonts and document images, Light/Dark/System, typing and autosave, native Save/Save As/export, Word/Grid/PDF printing, and authorized document hyperlinks. Inspect browser CSP violations and the Network panel; remote fetches, images, scripts, child frames and form submissions must be refused. A blocked required local operation is a compatibility failure to investigate, not a reason to add a broad `https:` allowance. The isolation boundary is the frame's sandbox, not this policy: the Hyori host runs every editor in a sandboxed, opaque-origin frame (see [protocol 3](editor-runtime-protocol.md#sandboxed-frame-protocol-3)), so compromised editor code cannot read the host page, its storage or cookies, or call `/api/*` with the person's session. CSP still limits what that code can load; it does not block every navigation-based exfiltration path, such as a popup to an attacker's page carrying the open document.

The `sandbox` directive closes a second way in. Because the frame may open popups that escape its sandbox (so hyperlinks work), it could open an editor page as an ordinary top-level tab, and that tab, like any link to an editor page from another site, used to run with Hyori's origin and session. Upstream PdfCraft's page also fetches any `?file=<url>` it is handed, so `/artcraft/pdfcraft/<version>/index.html?file=/api/storage/files/<id>…` parsed a chosen file with the person's authority. Now every `/artcraft` response carries the sandbox, and Hyori's PdfCraft build has no `?file=` intake. `scripts/browser-fixtures/editor-probe/isolation.test.ts` covers the frame-opened popup, a direct visit and the `?file=` URL; each reached the person's storage and session before this change and reaches nothing after it.

What else a frame-opened popup can reach, and why it gives the frame nothing:

- **Hyori's own pages (`/`, share pages under `/s/`).** The frame is cross-origin to the tab, so it can't read or script it, only navigate or close it, as any external site can with a tab it opens. The navigation starts in an opaque origin, so it is cross-site and the `SameSite=Strict` session isn't sent with it. The Hyori web client listens to `message` events only from the exact editor frame it created, and never reads `window.opener`.
- **Stored files (`/api/storage/files/<id>`).** Opened as a document, a file is served with `Content-Security-Policy: sandbox; default-src 'none'` and `Content-Disposition`, so it runs no script and has no origin. The frame can't read it, and the navigation carries no session.
- **Editor pages.** Sandboxed by their own response, as above.

```caddyfile
handle_path /artcraft/* {
    route {
        root * /srv/artcraft
        header X-Content-Type-Options nosniff
        header X-Frame-Options SAMEORIGIN
        # The editor frame is sandboxed into an opaque origin, so its scripts and WASM load with CORS.
        header Access-Control-Allow-Origin *
        # Replace with the line `bun scripts/editor-csp.ts` prints for this bundle.
        header Content-Security-Policy "<printed by scripts/editor-csp.ts>"
        header Cache-Control no-cache
        @immutable {
            path_regexp editor_hashed ^/(wordcraft|gridcraft|pdfcraft|deckcraft)/[^/]+/[^/]+-[0-9a-f]{15,20}(_bg)?\.(wasm|js|css)$
            file {path}
        }
        header @immutable Cache-Control "public, max-age=31536000, immutable"
        encode gzip
        @wasm path *.wasm
        header @wasm Content-Type application/wasm
        @javascript path *.js
        header @javascript Content-Type text/javascript
        file_server {
            precompressed gzip
        }
    }
}
handle {
    reverse_proxy web:3001 {
        header_up -Forwarded
    }
}
```

The executable handler owner is `scripts/editor-static-handler.ts`, exercised against real Caddy by `bun run test:editor-static`. `scripts/editor-csp.ts` owns the policy: the development gateway (`scripts/dev-stack.ts`) and the browser harness gateway (`scripts/browser-fixtures/front-proxy.ts`) derive it from their bundle at startup in the same way. Explicit `route` ordering keeps the conservative default header from overwriting the hashed-file cache policy. Only existing top-level content-hashed JS/WASM/CSS files qualify; missing matching paths remain revalidated 404s. Keep index pages, manifests, snippets and notices revalidated, preserve ranges/MIME types, and leave directory browsing disabled.

`precompressed gzip` serves a verified `.gz` sidecar byte-for-byte when negotiated; it does not alter original payload identity. Dynamic gzip remains a compatibility fallback when no sidecar exists. Ship sidecars only in a separately verified version-2 runtime inventory, never by adding files to an existing immutable bundle. The current `bb6…` runtime has no installed sidecars. Neither static transport tests nor these headers establish parsed-document load or durable-save latency; see [measurement boundaries](editor-performance.md).

The runtime notice entry is `/artcraft/legal/RUNTIME-NOTICE-INDEX.md`; retain its linked notices and source references alongside the payloads. A checksum is not a legal opinion or a substitute for those obligations.

## Upgrading to sandboxed editor frames

This release sandboxes every editor frame without `allow-same-origin`. Protocol 3 runtimes (`hyori-correlated-host-v3`) r3 and r4 start there. The current r4 versions are Word `0.14.0-hyori-host.5`, Grid `0.15.0-hyori-host.4`, PDF `0.17.0-hyori-host.4` and Deck `0.14.1-hyori-host.7`; r3 remains accepted and usable. Earlier protocol 1/2 bundles keep verifying, so no data or session state is touched, but their editors don't open: people see "This editor needs an update" until the bundle is replaced. Upgrade in this order:

1. Build and verify the protocol 3 bundle with this release's ArtCraft tooling, on the build machine, and record its receipt and manifest SHA-256. The tooling writes `runtime-native-v3-r4.json`. Rebuild the server image with that authority before mounting r4; its manifest SHA-256 is `322272308851138cd682a031ee15c6b658d2c752a771aff3135cc608208cfed7`.
2. Add `header Access-Control-Allow-Origin *` to the `/artcraft/*` handler, as shown above. The header is harmless for the old bundle, so it can go first. Without it, the sandboxed frame can't load the editor's own scripts and WASM, and the editors stay on their loading text.
3. Print the gateway's Content-Security-Policy line for the new bundle with `bun scripts/editor-csp.ts`. It refuses an older bundle and names the runtimes that predate sandboxed frames. The line now starts with `sandbox …`; a gateway still sending the previous line serves editor pages that run with Hyori's origin when opened outside the frame, so replace it, don't keep it.
4. Mount the new bundle in the backend and the gateway, set `HYORI_EDITOR_ASSETS_MANIFEST_SHA256`, then restart the backend with this release and reload the gateway. A backend started on an older bundle logs `Editor runtime predates sandboxed editor frames` once per editor.

Do steps 2 to 4 in one maintenance window. Between the new release and the new bundle, documents don't open in an editor; people see the update message instead. Files, sharing and downloads are unaffected.

### r5: the development default

r5 is the accepted development default: `scripts/dev-stack.ts` selects its receipt unless `HYORI_DEV_EDITOR_RECEIPT` names another. r4 and its immutable inventory remain unchanged and accepted by the server. The r5 manifest SHA-256 is `2e248a3aedfbd976bc28d29d44f52dec8e7ddbdf4149b1e28cc4a2613f3b7b25`, receipt `tooling/artcraft/runtime-all4-native-v3-r5.json`. Versions are Word `0.14.0-hyori-host.6`, Grid `0.15.0-hyori-host.5`, PDF `0.17.0-hyori-host.5` and Deck `0.14.1-hyori-host.8`. A deployment still selects its bundle explicitly, by mounting it and setting `HYORI_EDITOR_ASSETS_MANIFEST_SHA256`; nothing upgrades automatically.

It streams transferred, verified engine bytes without the additional whole-buffer `Response` copy, and repairs Deck's shadowed Paste Formatting shortcut through the existing UI hookup, without reordering the upstream engine registry. With a painter armed, Mod+Shift+V applies it without inserting clipboard text. With none armed, the paired paste event supplies the OS clipboard once, even when the internal copy differs. Stock fields keep their own behavior. The PDF author accepting-version guard includes both r4 and r5; r3 still receives no author property. Sandbox, CSP policy and asset verification stay unchanged. See [the measured boundaries](editor-performance.md#r5-handoff-profiling-and-visible-content-boundary): visible-content non-regression and the 1000 ms worst-case target have not been established.

`scripts/artcraft/check-deck-clipboard.ts` is an opt-in real-stack regression using headed Chromium and real X11 keys. Its source documents the private fixture-state, fresh upload and output-directory inputs; never commit or share that state's cookies. The r4 run fails on internal A plus OS B and the r5 run passes, including armed formatting, one undo, focus retention and unarmed paste. Unit hookup tests additionally require the engine registry files to remain byte-identical.

### r5 → r6: keep open tabs saving during the rollout

Deploy r6 as the current bundle and keep the exact r5 bundle as a separate, read-only retained mount. New opens get r6; existing r5 sessions keep their exact asset URLs and can still prepare, complete and replay a save. Session expiry, file access and the per-editor disable switch still apply to both. Do not combine either bundle's files, authority, or CSP hashes with the other.

1. Build the server with both compiled-in authorities. Set the existing `HYORI_EDITOR_ASSETS_*` values to the verified r6 directory and SHA-256. Set `HYORI_EDITOR_RETAINED_ASSETS_DIR` to the existing immutable r5 directory and `HYORI_EDITOR_RETAINED_ASSETS_MANIFEST_SHA256` to the r5 digest above. Include `docker-compose.editors-retained.yml` **after** `docker-compose.editors.yml`. The server checks both inventories before serving. These mounts do not replace any storage or database volume.
2. In the gateway mount r6 at `/srv/artcraft` and r5 at `/srv/artcraft-retained`. Replace only the `/artcraft/*` handler with the output of this command, keeping the site's existing TLS and proxy fallback:

   ```sh
   bun scripts/editor-static-handler.ts /path/to/r6 tooling/artcraft/runtime-all4-native-v3-r6.json \
     /path/to/r5 tooling/artcraft/runtime-all4-native-v3-r5.json
   ```

   Reload the gateway **before** switching the backend's current selection. r5's existing version paths keep resolving with r5's CSP while the old backend is still serving. Check both bundles' entry URLs and CSP before exposing new r6 opens. The current notices stay under `/artcraft/legal/`; the retained notices and manifest are under `/artcraft/retained/`. Asset CORS stays wildcard and noncredentialed.

3. Keep r5 for at least 24 hours after new opens start using r6, and longer if open r5 tabs still need time to save. In a later release, remove the retained backend overlay and retained gateway routes/mount after the drain. Removing them intentionally ends r5 session support; it is not an automatic timer or a step in this rollout.

## Opt-in gateway client addresses for authentication limits

Client-address attribution requires **both** settings below. They are runtime settings, not browser variables. Merely adding them to `.env.deployment` does not pass them into the shipped Compose services; supply a Compose override too. With both unset, the web host removes forwarded client-address headers, Rust does not trust the web host to name a client, and unknown browsers behind it retain one shared ten-attempt login budget per email per 15 minutes. A previously authenticated device retains its separate budget. This preserves the default behavior, including the ability for someone who knows an email to exhaust that shared budget.

- Web service: `HYORI_GATEWAY_CLIENT_ADDRESS_HEADER=x-forwarded-for`. The web host accepts only one physical instance of this header, takes its last comma-separated entry, requires an IPv4 or IPv6 literal without a port, brackets or zone identifier, and forwards that address as `x-hyori-client-address`. It always removes a caller-supplied `x-hyori-client-address`, even when the setting is unset.
- Backend service: `HYORI_TRUSTED_PROXIES=<web host's TCP source IP>`. This is a comma-separated list of IP literals or canonical CIDRs, not hostnames, URLs or Caddy's address. Rust trusts only the immediate web-host peer to supply exactly one valid `x-hyori-client-address`. Empty/unset means no trusted proxies. Do not trust every address or a whole Docker subnet when one fixed web address is sufficient. Missing, duplicate or malformed address evidence from a trusted peer leaves the client unknown; it does not use the proxy's address as a shared client budget.

For the shipped stack behind **one Caddy directly facing clients**, retain the existing HTTPS site and `/artcraft/*` handler above. Its fallback `reverse_proxy web:3001 { header_up -Forwarded }` is sufficient when Caddy shares the Docker network. A host-installed Caddy instead uses `reverse_proxy 127.0.0.1:3001` (or `HYORI_WEB_PORT`) with the same `header_up -Forwarded`. Caddy's default reverse proxy replaces untrusted incoming `X-Forwarded-For` with its TCP peer address; do not enable broad `trusted_proxies`, preserve arbitrary caller forwarding headers, or override that behavior with a caller-provided value. Preserve the public Host and keep `APP_ORIGIN` identical on web and backend.

For example, save this as an operator-owned `compose.gateway-address.yml`. Choose an unused private subnet appropriate to the host; these addresses are examples, not autodiscovery. This pins the web host's backend-facing source address so recreation does not silently invalidate Rust's allowlist:

```yaml
services:
  web:
    environment:
      HYORI_GATEWAY_CLIENT_ADDRESS_HEADER: x-forwarded-for
    networks:
      default:
        ipv4_address: 172.30.0.10
  backend:
    environment:
      HYORI_TRUSTED_PROXIES: 172.30.0.10/32
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24
```

Include that override with the same project, deployment environment and existing editor overlay when starting the stack. Inspect the resolved configuration with `docker compose --env-file .env.deployment -f docker-compose.yml -f compose.gateway-address.yml config` (add the editor overlay if used). Confirm the actual web source address observed by the backend matches the allowlist. Changing an existing network requires planned downtime and configuration review; never remove persistent volumes, rename the project or reset data for this setting. If instead using a dynamically allocated web IP, discover it with `docker inspect` and update the backend allowlist after every web recreation; a stale entry silently restores unknown-client limits. If the web host reaches Rust over loopback outside Docker, trust only that observed loopback address, not the example Docker IP.

With both settings working, unknown-browser logins spend ten attempts per email and client address and at most 100 attempts per address across emails per 15 minutes. IPv4 uses the address; IPv6 shares a budget across its /64, including privacy addresses. Setup, invite and link-password attempts have ten attempts per client per secret and a 100-attempt ceiling per secret across identified clients. Failed attempts from one address therefore do not alone exhaust a different address's login budget. Shared NATs and IPv6 /64s still share budgets. This is abuse attribution, not authentication or authorization.

With only the web setting, Rust ignores the forwarded address from the unlisted private peer. With only the backend setting, the web host supplies no address. Neither half-configuration refuses startup or breaks ordinary requests; both silently retain unknown-client/shared-email limits. Verify attribution after deployment rather than treating a healthy response as proof of correct configuration. A direct public TCP peer reaching Rust has its own address-based budget even without trusted proxies; do not expose the private Rust port.

**Only the gateway may reach the web host.** Its opt-in trusts the configured header without authenticating the upstream sender. A caller reaching the web host directly can select its own rate-limit address. The shipped Compose publication remains `127.0.0.1:${HYORI_WEB_PORT:-3001}:3001`, not a public bind; keep it that way for host Caddy and firewall untrusted local workloads. Loopback publication does not isolate other containers on the Docker network or processes on the host. Restrict network membership and do not expose another route to the web service. Keep the backend unexposed as well. This accepted deployment trust boundary is essential, not an optional hardening step.

A CDN or second reverse proxy changes the meaning of Caddy's TCP peer. With the recipe unchanged, the address counted is the CDN/outer proxy, so its users share a budget. Do not simply point the web setting at the CDN's header: an untrusted caller could supply it. Configure Caddy using that provider's authenticated, restricted ingress and exact trusted proxy ranges, strip/replace the provider header at the ingress, and deliberately emit one sanitized IP literal into a dedicated gateway-owned header (then name that header in the web setting). Simply preserving an `X-Forwarded-For` chain can leave the nearest proxy as its last entry, which this web host would count instead of the browser. Restrict Caddy to traffic from the outer proxy where required, account for every hop, and repeat the spoofing and two-client lockout checks on the actual topology. The single-hop evidence does not validate a CDN or multi-proxy deployment.

## Acceptance and data-preserving upgrade

Before upgrading a user-facing instance, verify the exact final bundle with the built backend and HTTPS web host, then open, edit, save and freshly reopen a synthetic document in each of WordCraft, GridCraft, DeckCraft and PdfCraft. Check the reopened content, not merely a frame-ready message. Exercise explicit destinations, read-only copies, stale-revision conflicts and recovery through the public SDK. Keep asset composition, functional evidence and architecture checks separate.

Retain the prior images, deployment configuration and runtime receipt, and back up PostgreSQL **and** object storage. Preserve the existing account/auth/storage configuration and volume names. Allow the backend's 150-second stop grace to drain admitted writes. A failed startup must be investigated, not bypassed with a synthetic purpose, disabled TLS checks or a rewritten migration checksum. Additive database migrations are not automatically reversed by reverting an image; choose a compatible rollback deliberately.

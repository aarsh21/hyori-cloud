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

For Caddy, mount the bundle at `/srv/artcraft` and place this handler **inside your existing HTTPS site**, ahead of a fallback `handle` containing your existing `reverse_proxy`. Keep your actual certificate, hostname, port and host/forwarded-header policy unchanged:

```caddyfile
handle_path /artcraft/* {
    route {
        root * /srv/artcraft
        header X-Content-Type-Options nosniff
        header X-Frame-Options SAMEORIGIN
        header Content-Security-Policy "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
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

The executable handler owner is `scripts/editor-static-handler.ts`, exercised against real Caddy by `bun run test:editor-static`. Explicit `route` ordering keeps the conservative default header from overwriting the hashed-file cache policy. Only existing top-level content-hashed JS/WASM/CSS files qualify; missing matching paths remain revalidated 404s. Keep index pages, manifests, snippets and notices revalidated, preserve ranges/MIME types, and leave directory browsing disabled.

`precompressed gzip` serves a verified `.gz` sidecar byte-for-byte when negotiated; it does not alter original payload identity. Dynamic gzip remains a compatibility fallback when no sidecar exists. Ship sidecars only in a separately verified version-2 runtime inventory, never by adding files to an existing immutable bundle. The current `bb6…` runtime has no installed sidecars. Neither static transport tests nor these headers establish parsed-document load or durable-save latency; see [measurement boundaries](editor-performance.md).

The runtime notice entry is `/artcraft/legal/RUNTIME-NOTICE-INDEX.md`; retain its linked notices and source references alongside the payloads. A checksum is not a legal opinion or a substitute for those obligations.

## Acceptance and data-preserving upgrade

Before upgrading a user-facing instance, verify the exact final bundle with the built backend and HTTPS web host, then open, edit, save and freshly reopen a synthetic document in each of WordCraft, GridCraft, DeckCraft and PdfCraft. Check the reopened content, not merely a frame-ready message. Exercise explicit destinations, read-only copies, stale-revision conflicts and recovery through the public SDK. Keep asset composition, functional evidence and architecture checks separate.

Retain the prior images, deployment configuration and runtime receipt, and back up PostgreSQL **and** object storage. Preserve the existing account/auth/storage configuration and volume names. Allow the backend's 150-second stop grace to drain admitted writes. A failed startup must be investigated, not bypassed with a synthetic purpose, disabled TLS checks or a rewritten migration checksum. Additive database migrations are not automatically reversed by reverting an image; choose a compatible rollback deliberately.

/**
 * Inside the existing HTTPS site; the operator retains TLS, origin and fallback routing. The policy
 * comes from `editorContentSecurityPolicy` for the bundle mounted at `/srv/artcraft`.
 */
export const editorStaticHandler = (contentSecurityPolicy: string) => `handle_path /artcraft/* {
    route {
        root * /srv/artcraft
        header X-Content-Type-Options nosniff
        header X-Frame-Options SAMEORIGIN
        # The editor frame is sandboxed into an opaque origin, so its scripts and WASM load with CORS.
        header Access-Control-Allow-Origin *
        header Content-Security-Policy "${contentSecurityPolicy}"
        header Cache-Control no-cache
        @immutable {
            path_regexp editor_hashed ^/(wordcraft|gridcraft|pdfcraft|deckcraft)/[^/]+/[^/]+-[0-9a-f]{15,20}(_bg)?\\.(wasm|js|css)$
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
}`;

/** Inside the existing HTTPS site; the operator retains TLS, origin and fallback routing. */
export const editorStaticHandler = `handle_path /artcraft/* {
    route {
        root * /srv/artcraft
        header X-Content-Type-Options nosniff
        header X-Frame-Options SAMEORIGIN
        header Content-Security-Policy "frame-ancestors 'self'"
        header Cache-Control no-cache
        @immutable {
            path_regexp editor_hashed ^/(wordcraft|gridcraft|pdfcraft|deckcraft)/[^/]+/[^/]+-[0-9a-f]{16}(_bg)?\\.(wasm|js|css)$
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

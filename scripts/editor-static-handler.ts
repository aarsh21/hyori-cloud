import { editorStaticBundle } from "./editor-csp.ts";

function serve(root: string, contentSecurityPolicy: string) {
  return `
    route {
        root * ${root}
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
    }`;
}

/** Keep the retained version paths on their own mount and CSP; never fall through to another root. */
export function editorStaticHandler(
  contentSecurityPolicy: string,
  retained?: ReturnType<typeof editorStaticBundle>,
) {
  const current = serve("/srv/artcraft", contentSecurityPolicy);

  if (retained === undefined) return `handle_path /artcraft/* {${current}\n}`;

  const previous = serve("/srv/artcraft-retained", retained.contentSecurityPolicy);
  const retainedPaths = retained.prefixes.map((path) => `${path}*`).join(" ");

  return `handle_path /artcraft/* {
    route {
        @retained_editor path ${retainedPaths}
        handle @retained_editor {${previous}
        }
        @retained_notices path /retained/legal/* /retained/runtime-bundle-manifest.json
        handle @retained_notices {
            uri strip_prefix /retained${previous}
        }
        handle {${current}
        }
    }
}`;
}

if (import.meta.main) {
  const [current, currentReceipt, retained, retainedReceipt] = process.argv.slice(2);

  if (process.argv.length !== 6 || !current || !currentReceipt || !retained || !retainedReceipt)
    throw new Error(
      "Usage: bun scripts/editor-static-handler.ts CURRENT CURRENT_RECEIPT RETAINED RETAINED_RECEIPT",
    );

  const active = editorStaticBundle(current, currentReceipt);
  const drain = editorStaticBundle(retained, retainedReceipt);

  if (drain.prefixes.some((prefix) => active.prefixes.includes(prefix)))
    throw new Error("Current and retained bundles share an editor version URL");

  console.log(editorStaticHandler(active.contentSecurityPolicy, drain));
}

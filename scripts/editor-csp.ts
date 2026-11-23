import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/**
 * The Content-Security-Policy every gateway sends with `/artcraft/*`. Each editor's index page
 * runs one inline loader and carries one inline `<style>`; both change with every build, so the
 * policy names their hashes rather than allowing inline code. Callers derive it once, at startup,
 * from the bundle they actually serve.
 */

const MANIFEST = "runtime-bundle-manifest.json";
const RECEIPTS = resolve(import.meta.dir, "../tooling/artcraft");

const Manifest = z.looseObject({
  editors: z.array(
    z.looseObject({
      app: z.string(),
      version: z.string(),
      assetUrl: z.string(),
      bridge: z.string().optional(),
    }),
  ),
});

/** The only runtime bridge this release opens: the first that runs in a sandboxed editor frame. */
const SANDBOXED_BRIDGE = "hyori-correlated-host-v3";

const Receipt = z.looseObject({
  manifestSha256: z.string(),
  editors: z.array(
    z.looseObject({
      app: z.string(),
      version: z.string(),
      cspScriptHashes: z.array(z.string()).optional(),
    }),
  ),
});

const sha256 = (text: string | Buffer) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** Inline element bodies, byte for byte as the browser hashes them. */
function inline(page: string, tag: "script" | "style") {
  const opening = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");

  return [...page.matchAll(opening)].flatMap(([, attributes = "", body = ""]) =>
    /\bsrc\s*=/i.test(attributes) ? [] : [sha256(body)],
  );
}

/** The committed handoff that names this exact manifest, when there is one. */
function findReceipt(manifestSha256: string) {
  for (const name of readdirSync(RECEIPTS)) {
    if (!name.endsWith(".json")) continue;

    const receipt = Receipt.safeParse(JSON.parse(readFileSync(join(RECEIPTS, name), "utf8")));

    if (receipt.success && receipt.data.manifestSha256 === manifestSha256) {
      return join(RECEIPTS, name);
    }
  }

  return null;
}

/**
 * Every `/artcraft` response is sandboxed into an opaque origin, however it is reached: in the
 * host's frame, opened by it as a popup, followed from a link or typed in. The tokens are exactly the
 * host frame's (`EDITOR_FRAME_SANDBOX`), so its hyperlinks still open ordinary pages.
 */
export const EDITOR_DOCUMENT_SANDBOX =
  "sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

/**
 * Reads the bundle's index pages and, when a receipt records them, requires its loader hashes to be
 * exactly the ones in those pages, so a stale receipt or a modified bundle fails at startup.
 */
export function editorStaticBundle(bundle: string, receiptPath?: string) {
  const manifestBytes = readFileSync(join(bundle, MANIFEST));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const { editors } = Manifest.parse(JSON.parse(manifestBytes.toString()));
  const receiptFile = receiptPath ?? findReceipt(manifestSha256);

  const receipt =
    receiptFile === null ? null : Receipt.parse(JSON.parse(readFileSync(receiptFile, "utf8")));

  if (receipt !== null && receipt.manifestSha256 !== manifestSha256) {
    throw new Error(
      `${receiptFile} names manifest ${receipt.manifestSha256}, not ${manifestSha256}.`,
    );
  }

  // Tell the operator now, not a person opening a document: an older runtime never starts.
  const outdated = editors.filter(
    ({ bridge }) => bridge !== undefined && bridge !== SANDBOXED_BRIDGE,
  );

  if (outdated.length > 0) {
    throw new Error(
      `${outdated.map(({ app, version }) => `${app} ${version}`).join(", ")} predate sandboxed editor frames, so this release can't open them. Rebuild the editor bundle with this release's tooling (see docs/editor-deployment.md), then print this line again.`,
    );
  }

  const scripts = new Set<string>();
  const styles = new Set<string>();
  const prefixes: string[] = [];

  for (const { app, version, assetUrl } of editors) {
    if (
      !/^(?:wordcraft|gridcraft|pdfcraft|deckcraft)$/u.test(app) ||
      !/^[\w][\w.-]*$/u.test(version)
    )
      throw new Error(`Invalid editor asset prefix: ${app} ${version}`);

    const index = new URL(assetUrl, "https://editor.invalid").pathname.replace(/^\/artcraft\//, "");

    if (index !== `${app}/${version}/index.html`)
      throw new Error(`Editor asset URL does not match its version: ${assetUrl}`);

    prefixes.push(`/${app}/${version}/`);
    const page = readFileSync(join(bundle, index), "utf8");
    const pageScripts = inline(page, "script");

    const recorded = receipt?.editors.find(
      (entry) => entry.app === app && entry.version === version,
    );

    if (recorded?.cspScriptHashes !== undefined) {
      const expected = recorded.cspScriptHashes.map((hash) => `'${hash}'`).toSorted();

      if (expected.join(" ") !== pageScripts.toSorted().join(" ")) {
        throw new Error(`${index} inline scripts do not match ${receiptFile}.`);
      }
    }

    for (const hash of pageScripts) scripts.add(hash);

    for (const hash of inline(page, "style")) styles.add(hash);
  }

  const contentSecurityPolicy = [
    EDITOR_DOCUMENT_SANDBOX,
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' blob: data:",
    "frame-src 'self' blob:",
    "form-action 'none'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...scripts].join(" "),
    ["style-src 'self'", ...styles].join(" "),
  ].join("; ");

  return { contentSecurityPolicy, prefixes };
}

export function editorContentSecurityPolicy(bundle: string, receiptPath?: string) {
  return editorStaticBundle(bundle, receiptPath).contentSecurityPolicy;
}

// Production Caddy: `bun scripts/editor-csp.ts <bundle> [receipt]` prints the exact header line.
if (import.meta.main) {
  const [bundle, receipt] = process.argv.slice(2);

  if (bundle === undefined) {
    console.error("Usage: bun scripts/editor-csp.ts <bundle directory> [receipt.json]");
    process.exit(2);
  }

  console.log(`header Content-Security-Policy "${editorContentSecurityPolicy(bundle, receipt)}"`);
}

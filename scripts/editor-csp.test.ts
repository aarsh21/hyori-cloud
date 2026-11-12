import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorContentSecurityPolicy } from "./editor-csp.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bundle(bridge: string) {
  const root = mkdtempSync(join(tmpdir(), "hyori-editor-csp-"));
  roots.push(root);
  mkdirSync(join(root, "wordcraft/1"), { recursive: true });
  writeFileSync(join(root, "wordcraft/1/index.html"), '<script type="module">start();</script>');
  writeFileSync(
    join(root, "runtime-bundle-manifest.json"),
    JSON.stringify({
      editors: [
        { app: "wordcraft", version: "1", bridge, assetUrl: "/artcraft/wordcraft/1/index.html" },
      ],
    }),
  );

  return root;
}

// The operator learns at startup, before a person opens a document and waits on it.
test("a bundle that predates sandboxed editor frames is refused before it is served", () => {
  expect(() => editorContentSecurityPolicy(bundle("hyori-correlated-host-v2"))).toThrow(
    "wordcraft 1 predate sandboxed editor frames",
  );
  expect(editorContentSecurityPolicy(bundle("hyori-correlated-host-v3"))).toContain(
    "frame-ancestors 'self'",
  );
});

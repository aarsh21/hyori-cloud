import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PDF_ANNOTATION_AUTHOR_VERSIONS } from "@hyori-cloud/client-sdk/editor-runtime";
import { nativeArtifactVersions } from "./native-frame-patch.ts";

test("the pinned PDFCraft build receives annotation authors from the SDK", () => {
  expect(PDF_ANNOTATION_AUTHOR_VERSIONS).toContain(nativeArtifactVersions.pdfcraft);
});

// Bundle authored code and its public dependency boundary; do not execute any vendor WASM.
test("new native bridge browser entry consumes canonical public codecs without a second wire-schema owner", async () => {
  const protocol = await readFile(
    "tooling/artcraft/patches/native-host-v3/host-protocol.ts",
    "utf8",
  );

  expect(protocol).toContain('from "@hyori-cloud/client-sdk/editor-runtime"');
  expect(protocol).not.toMatch(/from ["']zod["']|z\.object|Schema\.Struct/);

  const result = await Bun.build({
    entrypoints: ["tooling/artcraft/patches/native-host-v3/host-entry.ts"],
    target: "browser",
    format: "esm",
    minify: true,
  });

  expect(result.logs).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBe(1);
  const code = await result.outputs[0]!.text();
  expect(code).toContain("prepareHost");
  expect(code).toContain("hostSerialized");
  expect(code).toContain("hostAcknowledged");
  expect(code).toContain("hostTakeCancellation");
  expect(code).toContain("hostTakeFailure");
  expect(code).toContain("hostThemeApplied");
  expect(code).not.toContain("KeyboardEvent");
  expect(code).not.toContain(".focus()");
});

test("an unrelated RPC catalog change leaves the built frame bridge byte-identical", async () => {
  const catalog = await readFile("packages/api/src/generated/operations.ts", "utf8");

  const changed = catalog.replace(
    'Rpc.make("admin.createInvite",',
    'Rpc.make("admin.unrelatedProbe",',
  );

  expect(changed).not.toBe(catalog);

  async function build(mutateCatalog: boolean) {
    const result = await Bun.build({
      entrypoints: ["tooling/artcraft/patches/native-host-v3/host-entry.ts"],
      target: "browser",
      format: "esm",
      minify: true,
      plugins: mutateCatalog
        ? [
            {
              name: "unrelated-rpc-change",
              setup(builder) {
                builder.onLoad(
                  { filter: /packages\/api\/src\/generated\/operations\.ts$/ },
                  () => ({
                    contents: changed,
                    loader: "ts",
                  }),
                );
              },
            },
          ]
        : [],
    });

    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);

    return createHash("sha256")
      .update(await result.outputs[0]!.text())
      .digest("hex");
  }

  const baseline = await build(false);
  const unrelatedChange = await build(true);
  console.log(`Frame bridge catalog isolation: ${baseline} → ${unrelatedChange}`);
  expect(unrelatedChange).toBe(baseline);
});

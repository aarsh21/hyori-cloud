import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const appName = z.enum(["wordcraft", "gridcraft", "pdfcraft", "deckcraft"]);
const inputs = z.object({ ARTCRAFT_TEST_INPUTS: z.string().optional() }).parse(process.env);

const fixtures = {
  wordcraft: { commit: "5cd53f184aab11def13b7fced18727159b9bc96a", methods: "word-native.rs" },
  gridcraft: { commit: "30b210b4ef03b30616923465efa70766cefba379", methods: "grid-native.rs" },
  pdfcraft: { commit: "7d78f3e14474b978be014715e0cc64895d77025a", methods: "pdf-native.rs" },
  deckcraft: { commit: "ee39ff67816d0039143ec7c98ea604cefe0cd2e5", methods: "deck-native.rs" },
};

for (const app of appName.options)
  test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
    `${app} direct-native-method source stage preserves old source bytes and refuses accidental second application`,
    async () => {
      const config = z
        .object({ editors: z.array(z.object({ app: appName, sourceArchive: z.string() })) })
        .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

      const pin = pins.editors.find((editor) => editor.app === app)!;

      const archive = await readFile(
        config.editors.find((editor) => editor.app === app)!.sourceArchive,
      );

      expect(sha256(archive)).toBe(pin.sourceSha256);
      const original = readGitSourceArchive(archive, `${app}-${pin.version}`, fixtures[app].commit);
      let base = original;

      if (app === "deckcraft") {
        expect(() =>
          patchNativeMethods(original, app, { types: Buffer.alloc(0), methods: Buffer.alloc(0) }),
        ).toThrow("explicit source base");
        base = patchDeckCraft(original, {
          hostRust: await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
          hostJavaScript: await readFile(
            "tooling/artcraft/patches/deckcraft-host-v2/host-bridge.js.source",
          ),
        }).files;
      }

      const types = await readFile("tooling/artcraft/patches/native-host-v3/native-types.rs");

      const methods = await readFile(
        `tooling/artcraft/patches/native-host-v3/${fixtures[app].methods}`,
      );

      const result = patchNativeMethods(base, app, { types, methods });
      expect(result.stage).toBe("direct-native-methods-only-not-connected");
      expect(result.changes.length).toBe(3);
      const parent = app === "pdfcraft" ? "editing" : "app";
      const added = `crates/ui-egui/src/${parent}/native_host.rs`;
      expect(
        result.files.get(added)!.equals(Buffer.concat([types, Buffer.from("\n"), methods])),
      ).toBe(true);
      expect(result.files.get("Cargo.lock")!.equals(original.get("Cargo.lock")!)).toBe(true);

      for (const path of [
        "LICENSE-MIT",
        "LICENSE-APACHE",
        "NOTICE",
        "ATTRIBUTION.md",
        "docs/brand/LICENSE-brand.txt",
      ])
        if (original.has(path))
          expect(result.files.get(path)!.equals(original.get(path)!)).toBe(true);

      for (const [path, body] of base)
        if (!result.changes.some((change) => change.path === path))
          expect(result.files.get(path)!.equals(body)).toBe(true);
      expect(() => patchNativeMethods(result.files, app, { types, methods })).toThrow("Refusing");
      expect(methods.toString()).not.toMatch(/\.focus\(|KeyboardEvent|\.run\("file\.save"/);
    },
    120000,
  );

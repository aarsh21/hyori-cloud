import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { patchDeckNativeHookup } from "./deck-native-hookup.ts";

const inputs = z.object({ ARTCRAFT_TEST_INPUTS: z.string().optional() }).parse(process.env);
const root = "tooling/artcraft/patches/native-host-v3";

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
  "Deck native hookup retains chosen PDF options and replaces unsafe close-on-download with a held job",
  async () => {
    const config = z
      .object({ editors: z.array(z.object({ app: z.string(), sourceArchive: z.string() })) })
      .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

    const archive = await readFile(
      config.editors.find((editor) => editor.app === "deckcraft")!.sourceArchive,
    );

    expect(sha256(archive)).toBe(
      pins.editors.find((editor) => editor.app === "deckcraft")!.sourceSha256,
    );

    const original = readGitSourceArchive(
      archive,
      "deckcraft-0.14.1",
      "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
    );

    const retained = patchDeckCraft(original, {
      hostRust: await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
      hostJavaScript: await readFile(
        "tooling/artcraft/patches/deckcraft-host-v2/host-bridge.js.source",
      ),
    }).files;

    const base = patchNativeMethods(retained, "deckcraft", {
      types: await readFile(`${root}/native-types.rs`),
      intents: await readFile(`${root}/native-intent.rs`),
      methods: await readFile(`${root}/deck-native.rs`),
      jobs: await readFile(`${root}/deck-jobs.rs`),
    }).files;

    const adapter = await readFile(`${root}/deck-frame.rs`);
    const result = patchDeckNativeHookup(base, adapter);

    for (const path of [
      "crates/ui-egui/src/app/native_host.rs",
      ...result.changes.map((change) => change.path),
    ])
      if (path.endsWith(".rs"))
        expect(() =>
          execFileSync(
            "rustfmt",
            ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
            {
              input: result.files.get(path),
              maxBuffer: 4 * 1024 * 1024,
            },
          ),
        ).not.toThrow();
    expect(result.files.get("Cargo.lock")!.equals(original.get("Cargo.lock")!)).toBe(true);
    expect(result.files.get("Cargo.toml")!.equals(original.get("Cargo.toml")!)).toBe(true);
    const files = result.files.get("crates/ui-egui/src/app/files.rs")!.toString();
    expect(files).toContain("let options = extra.clone();");
    expect(files).toContain("native_host_serialize_options(document, name, reason, &options)");
    const dialogs = result.files.get("crates/ui-egui/src/dialogs/body.rs")!.toString();
    expect(dialogs.indexOf("native_host_close_after_save")).toBeLessThan(
      dialogs.indexOf("app.save();"),
    );
    const web = result.files.get("apps/deckcraft-web/src/web.rs")!.toString();
    expect(web).not.toContain("host::Bridge");
    expect(web.indexOf("host.note_input")).toBeLessThan(
      web.indexOf("std::mem::take(&mut raw.dropped_files)"),
    );
    expect(web).toContain("host.after_logic");
    expect(web).toContain("host.after_ui");
    expect(() => patchDeckNativeHookup(result.files, adapter)).toThrow();

    for (const [path, bytes] of base)
      if (!result.changes.some((change) => change.path === path))
        expect(result.files.get(path)!.equals(bytes)).toBe(true);
  },
);

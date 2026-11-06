import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";
import { patchWordNativeHookup } from "./word-native-hookup.ts";

const inputs = z.object({ ARTCRAFT_TEST_INPUTS: z.string().optional() }).parse(process.env);
const root = "tooling/artcraft/patches/native-host-v3";

test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
  "Word source hookup preserves exact export options and defers SaveChanges behind the native job",
  async () => {
    const config = z
      .object({ editors: z.array(z.object({ app: z.string(), sourceArchive: z.string() })) })
      .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

    const archive = await readFile(
      config.editors.find((editor) => editor.app === "wordcraft")!.sourceArchive,
    );
    expect(sha256(archive)).toBe(
      pins.editors.find((editor) => editor.app === "wordcraft")!.sourceSha256,
    );
    const original = readGitSourceArchive(
      archive,
      "wordcraft-0.14.0",
      "5cd53f184aab11def13b7fced18727159b9bc96a",
    );

    const base = patchNativeMethods(original, "wordcraft", {
      types: await readFile(`${root}/native-types.rs`),
      intents: await readFile(`${root}/native-intent.rs`),
      methods: await readFile(`${root}/word-native.rs`),
      jobs: await readFile(`${root}/word-jobs.rs`),
    }).files;

    const adapter = await readFile(`${root}/word-frame.rs`);
    const result = patchWordNativeHookup(base, adapter);

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
    expect(result.files.get("crates/ui-egui/src/chrome.rs")!.toString()).toContain(
      "Cloud saving managed by Hyori",
    );
    expect(result.files.get("Cargo.lock")!.equals(original.get("Cargo.lock")!)).toBe(true);
    expect(result.files.get("Cargo.toml")!.equals(original.get("Cargo.toml")!)).toBe(true);
    const commands = result.files.get("crates/ui-egui/src/app/commands.rs")!.toString();
    expect(commands.indexOf("native_host_begin_intent")).toBeLessThan(
      commands.indexOf("// Web: saving and exporting become downloads."),
    );
    expect(commands).toContain("&options, native_save");
    const files = result.files.get("crates/ui-egui/src/app/files.rs")!.toString();
    expect(files).toContain("Some(continuation)");
    expect(files.indexOf("Some(continuation)")).toBeLessThan(
      files.indexOf("let go = match choice"),
    );
    const web = result.files.get("apps/wordcraft-web/src/web.rs")!.toString();
    expect(web).not.toContain("crate::host::Bridge");
    expect(web).toContain("NATIVE_ARTIFACT_VERSION");
    expect(web.indexOf("host.note_input")).toBeLessThan(web.indexOf("self.app.raw_input_hook"));
    expect(web).toContain("host.after_ui");
    expect(() => patchWordNativeHookup(result.files, adapter)).toThrow();

    for (const [path, bytes] of base)
      if (!result.changes.some((change) => change.path === path))
        expect(result.files.get(path)!.equals(bytes)).toBe(true);
  },
);

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { nativeArtifactVersions, patchNativeFrame } from "./native-frame-patch.ts";

const patches = "tooling/artcraft/patches/native-host-v3";

async function inputs() {
  const bundle = await Bun.build({
    entrypoints: [`${patches}/host-entry.ts`],
    target: "browser",
    format: "esm",
    minify: true,
  });

  expect(bundle.success).toBe(true);
  expect(bundle.outputs).toHaveLength(1);

  return {
    imports: await readFile(`${patches}/native-imports.rs`),
    adapter: await readFile(`${patches}/native-adapter.rs`),
    frame: await readFile(`${patches}/native-frame.rs`),
    clock: await readFile(`${patches}/native-clock.rs`),
    hostJavaScript: Buffer.from(await bundle.outputs[0]!.arrayBuffer()),
  };
}

test("shared frame composition uses exact modified artifact identity without changing Cargo versions or locks", async () => {
  const authored = await inputs();

  for (const app of ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"] as const) {
    const parent = app === "pdfcraft" ? "editing" : "app";
    const lock = Buffer.from("Synthetic unchanged lock witness");

    const source = new Map([
      ["Cargo.lock", lock],
      [`crates/ui-egui/src/${parent}/native_host.rs`, Buffer.from("pub struct NativeHostJob {}")],
    ]);

    const result = patchNativeFrame(source, app, authored);
    const web = `apps/${app}-web/src/native_host.rs`;
    expect(result.files.get(web)?.toString()).toContain(`"${nativeArtifactVersions[app]}"`);
    expect(result.files.get(web)?.toString()).toContain("pub struct NativeHostFrame");
    expect(result.files.get(web)?.toString()).toContain("pub trait NativeHostAdapter");
    expect(() =>
      execFileSync(
        "rustfmt",
        ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
        {
          input: result.files.get(web),
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    ).not.toThrow();
    expect(result.files.get("Cargo.lock")).toBe(lock);
    expect(result.files.get(`apps/${app}-web/src/native_host/clock.rs`)).toBe(authored.clock);
    expect(result.files.get(`apps/${app}-web/hyori-native-host.js`)).toBe(authored.hostJavaScript);
    expect(result.files.has("hyori-native-host.js")).toBe(false);
    expect(result.changes).toHaveLength(3);
    expect(source.size).toBe(2);
    expect(() => patchNativeFrame(result.files, app, authored)).toThrow("Refusing to replace");
  }
});

test("shared frame refuses missing intent prerequisites and never uses keyboard or focus workarounds", async () => {
  const authored = await inputs();
  expect(() => patchNativeFrame(new Map(), "wordcraft", authored)).toThrow(
    "intent/job types first",
  );
  expect(authored.frame.toString()).not.toMatch(/KeyboardEvent|\.focus\(|\.run\("file\.save/);
  expect(authored.frame.toString()).toContain("self.process_fences(app)?;");
  expect(authored.frame.toString()).toContain("self.process_ack(app)?;");
  expect(authored.frame.toString().indexOf("self.process_fences(app)?;")).toBeLessThan(
    authored.frame.toString().indexOf("self.process_ack(app)?;"),
  );
});

test("source ordering keeps pending raw input fenced until a nondiscarded UI pass before manual capture", async () => {
  const authored = await inputs();
  const source = authored.frame.toString();
  const note = source.slice(source.indexOf("pub fn note_input"), source.indexOf("fn revision"));
  expect(note).toContain(
    "self.input_pending |= !raw.events.is_empty() || !raw.dropped_files.is_empty();",
  );

  const logic = source.slice(
    source.indexOf("pub fn after_logic"),
    source.indexOf("pub fn after_ui"),
  );

  expect(logic.indexOf("if self.input_pending { return Ok(()) }")).toBeLessThan(
    logic.indexOf("self.process_capture(app)"),
  );
  const ui = source.slice(source.indexOf("pub fn after_ui"));
  expect(ui.indexOf("if ctx.will_discard() { return Ok(()) }")).toBeLessThan(
    ui.indexOf("self.input_pending = false;"),
  );
  expect(ui.indexOf("self.input_pending = false;")).toBeLessThan(
    ui.indexOf("self.process_capture(app)?;"),
  );
  expect(source).not.toContain("self.host_dirty |= model.is_some_and");
  expect(source).toContain("self.host_dirty |= !save_as && snapshot.identity.dirty;");
});

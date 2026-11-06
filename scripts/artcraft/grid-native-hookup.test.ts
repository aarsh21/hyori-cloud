import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { patchGridNativeHookup } from "./grid-native-hookup.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";

const inputs = z.object({ ARTCRAFT_TEST_GRID_ARCHIVE: z.string().optional() }).parse(process.env);
const root = "tooling/artcraft/patches/native-host-v3/";

async function authored() {
  const [types, intents, methods, jobs, frame] = await Promise.all(
    ["native-types.rs", "native-intent.rs", "grid-native.rs", "grid-jobs.rs", "grid-frame.rs"].map(
      (name) => readFile(root + name),
    ),
  );

  if (!types || !intents || !methods || !jobs || !frame)
    throw new Error("Grid authored inputs missing");

  return { types, intents, methods, jobs, frame };
}

test("Grid authored adapter uses shared types, opaque clock owner and guarded private jobs", async () => {
  const { methods, jobs, frame } = await authored();
  const source = methods.toString();
  const jobSource = jobs.toString();

  expect(
    source.indexOf("reason == NativeHostSaveReason::Automatic && self.native_host_pending_input()"),
  ).toBeLessThan(source.indexOf("self.settle_drafts()"));
  expect(source).toContain("std::sync::Arc::ptr_eq(&document.wb, &workbook)");
  expect(source).toContain('dialog.name != "saveChanges"');
  expect(source).toContain("self.synthetic_pending || !self.synthetic.is_empty()");
  expect(source).not.toMatch(/KeyboardEvent|\.focus\(/);
  expect(source).toContain("document.saved = document.wb.clone()");
  expect(jobSource).toContain("job.intent_id == intent_id && job.document_id == document_id");
  expect(jobSource).toContain("self.native_host_job = Some(job)");
  expect(jobSource).toContain("if exact_replacement && !self.native_host_pending_input()");
  expect(jobSource).toContain("std::sync::Arc::ptr_eq(marker, &pending.marker)");
  expect(jobSource).toContain("Cloud replacement cannot fall back to a local download");
  expect(jobSource).toContain("let mut options = params.clone()");
  expect(jobSource).toContain(
    'options.as_object_mut().ok_or(NativeHostFailure::IdentityChanged)?.remove("path")',
  );
  expect(jobSource).toContain('self.session.run("file.exportPdf", options)');
  expect(jobSource).toContain("download(&name, &bytes)");
  expect(jobSource).not.toMatch(/mark_saved|\.saved\s*=|postMessage|hostSerialized/);
  expect(frame.toString()).toContain("impl NativeHostAdapter for SheetApp");
  expect(frame.toString()).not.toMatch(/wrapping_add|postMessage|KeyboardEvent|NativeHostClock/);
  expect(() => patchGridNativeHookup(new Map())).toThrow("stage");
});

test.skipIf(!inputs.ARTCRAFT_TEST_GRID_ARCHIVE)(
  "Grid exact source-map hookup fences old saves, connects real frame and preserves local export settings",
  async () => {
    const pin = pins.editors.find((entry) => entry.app === "gridcraft")!;
    const archive = await readFile(inputs.ARTCRAFT_TEST_GRID_ARCHIVE!);
    expect(sha256(archive)).toBe(pin.sourceSha256);

    const original = readGitSourceArchive(
      archive,
      "gridcraft-0.15.0",
      "30b210b4ef03b30616923465efa70766cefba379",
    );

    const authoredInputs = await authored();
    const stage = patchNativeMethods(original, "gridcraft", authoredInputs).files;
    const before = new Map([...stage].map(([path, bytes]) => [path, sha256(bytes)]));
    const result = patchGridNativeHookup(stage);
    expect(() =>
      execFileSync(
        "rustfmt",
        ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
        { input: stage.get("crates/ui-egui/src/app/native_host.rs"), maxBuffer: 4 * 1024 * 1024 },
      ),
    ).not.toThrow();

    expect(result.changes.length).toBe(12);
    expect(result.files.get("apps/gridcraft-web/src/native_frame.rs")).toEqual(
      authoredInputs.frame,
    );
    expect(result.files.has("apps/gridcraft-web/src/native_host.rs")).toBe(false);
    const web = result.files.get("apps/gridcraft-web/src/web.rs")!.toString();

    expect(web).toContain('NativeHostFrame::prepare("gridcraft", NATIVE_ARTIFACT_VERSION)');

    for (const hook of [
      "host.note_input(&self.app, raw)",
      "host.before_logic(&mut self.app, ctx)",
      "host.after_logic(&mut self.app, ctx)",
      "host.after_ui(&mut self.app, ui.ctx())",
      "NativeHostFrame::ready()",
    ])
      expect(web).toContain(hook);

    for (const path of [
      "crates/ui-egui/src/ribbon/title_bar.rs",
      "crates/ui-egui/src/backstage/options.rs",
    ]) {
      const controls = result.files.get(path)!.toString();
      expect(controls).toContain("if app.native_host_intents.is_some()");
      expect(controls).toContain("Saving managed by Hyori");
      expect(controls).toContain("app.toggle_autosave()");
    }

    expect(web.indexOf("host.note_input(&self.app, raw)")).toBeLessThan(
      web.indexOf("self.app.raw_input_hook(ctx, raw)"),
    );
    expect(web.indexOf("host.before_logic(&mut self.app, ctx)")).toBeLessThan(
      web.indexOf("self.app.logic(ctx)"),
    );
    expect(web.indexOf("host.after_logic(&mut self.app, ctx)")).toBeGreaterThan(
      web.indexOf("self.app.logic(ctx)"),
    );
    expect(web.indexOf("host.after_ui(&mut self.app, ui.ctx())")).toBeGreaterThan(
      web.indexOf("self.app.ui(ui)"),
    );
    expect(web.indexOf("NativeHostFrame::ready()")).toBeGreaterThan(web.indexOf(".await;"));
    expect(web).not.toMatch(/bridge\.sync|bridge\.connect|bridge\.post_ready|crate::host/);
    const commands = result.files.get("crates/ui-egui/src/app/commands.rs")!.toString();

    expect(commands.indexOf("self.native_host_command(id, &params)")).toBeLessThan(
      commands.indexOf("self.settle_drafts()?"),
    );
    expect(commands).toContain("return self.export_pdf_with_picker(params)");
    expect(commands).toContain("self.deliver_pdf(r)");
    expect(result.files.get("crates/ui-egui/src/app/quit.rs")!.toString()).toContain(
      "self.native_host_save_changes(answer, quitting, ctx)",
    );
    expect(result.files.get("crates/ui-egui/src/app/files.rs")!.toString()).toContain(
      "if self.native_host_intents.is_some() { return; }",
    );
    expect(result.files.get("crates/ui-egui/src/dialogs/show.rs")!.toString()).toContain(
      "app.native_host_password_opened(d.native_host_open.as_ref())",
    );
    expect(result.files.get("crates/ui-egui/src/app/print.rs")).toEqual(
      original.get("crates/ui-egui/src/app/print.rs"),
    );
    expect(result.files.get("crates/engine/src/cmd/file.rs")).toEqual(
      original.get("crates/engine/src/cmd/file.rs"),
    );

    for (const [path, bytes] of stage) {
      expect(sha256(bytes)).toBe(before.get(path));

      if (!result.changes.some((change) => change.path === path))
        expect(result.files.get(path)).toEqual(bytes);
    }

    for (const change of result.changes) {
      expect(change.before).toBe(before.get(change.path) ?? null);
      expect(change.after).toBe(sha256(result.files.get(change.path)!));
      // Parser/format acceptance only: never execute vendor code or claim Rust typechecking/build.
      expect(() =>
        execFileSync(
          "rustfmt",
          ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
          { input: result.files.get(change.path), maxBuffer: 4 * 1024 * 1024 },
        ),
      ).not.toThrow();
    }

    expect(() => patchGridNativeHookup(result.files)).toThrow("second");
    expect(() => patchGridNativeHookup(original)).toThrow("stage");

    for (const path of result.changes
      .filter((change) => change.before)
      .map((change) => change.path)) {
      const missing = new Map(stage);
      missing.delete(path);
      expect(() => patchGridNativeHookup(missing)).toThrow();
      const changed = new Map(stage);
      changed.set(
        path,
        Buffer.concat([stage.get(path)!, Buffer.from("\n// unexpected source drift\n")]),
      );
      expect(() => patchGridNativeHookup(changed)).toThrow();
    }

    const duplicate = new Map(stage);
    duplicate.set(
      "crates/ui-egui/src/app.rs",
      Buffer.concat([
        stage.get("crates/ui-egui/src/app.rs")!,
        Buffer.from("\nmod native_host;\npub use native_host::{NativeHostJob};\n"),
      ]),
    );
    expect(() => patchGridNativeHookup(duplicate)).toThrow("duplicated");
    const staleJobs = new Map(stage);
    staleJobs.set(
      "crates/ui-egui/src/app/native_host.rs",
      Buffer.from("pub struct NativeHostJob;"),
    );
    expect(() => patchGridNativeHookup(staleJobs)).toThrow("stage");
  },
  120000,
);

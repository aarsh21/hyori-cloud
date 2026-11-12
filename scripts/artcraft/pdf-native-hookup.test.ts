import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { patchPdfNativeHookup } from "./pdf-native-hookup.ts";
import { patchNativeMethods } from "./native-methods-patch.ts";

const inputs = z.object({ ARTCRAFT_TEST_PDF_ARCHIVE: z.string().optional() }).parse(process.env);
const root = "tooling/artcraft/patches/native-host-v3/";

async function authored() {
  const [types, intents, methods, jobs, frame] = await Promise.all(
    ["native-types.rs", "native-intent.rs", "pdf-native.rs", "pdf-jobs.rs", "pdf-frame.rs"].map(
      (name) => readFile(root + name),
    ),
  );

  if (!types || !intents || !methods || !jobs || !frame)
    throw new Error("PDF authored inputs missing");

  return { types, intents, methods, jobs, frame };
}

test("PDF authored adapter keeps exact pre-apply guards and private cancellable continuations", async () => {
  const { methods, jobs, frame } = await authored();
  const source = methods.toString();
  const jobSource = jobs.toString();
  const adapter = frame.toString();

  expect(
    source.indexOf("reason == NativeHostSaveReason::Automatic && self.native_host_pending_input()"),
  ).toBeLessThan(source.indexOf("self.commit_typing_in(id)"));
  expect(source).toContain("std::sync::Arc::ptr_eq(&document.bytes, &working)");
  expect(source.indexOf("current.same_snapshot(snapshot.identity)")).toBeLessThan(
    source.indexOf("self.session.mark_saved(id"),
  );
  expect(source.indexOf("!(snapshot.guard)(self)")).toBeLessThan(
    source.indexOf("self.session.mark_saved(id"),
  );
  expect(source).toContain("self.session.check_save(id, &bytes)");
  expect(source).not.toMatch(/KeyboardEvent|\.focus\(|wrapping_add/);
  expect(jobSource).toContain("job.intent_id == intent_id && job.document_id == document_id");
  expect(jobSource).toContain("self.native_host_job = Some(job)");
  expect(jobSource).toContain("if exact_replacement && !self.native_host_pending_input()");
  expect(jobSource).toContain("std::sync::Arc::ptr_eq(source, &pending.source)");
  expect(jobSource).toContain("Cloud replacement cannot fall back to a local download");
  expect(jobSource).not.toMatch(/mark_saved|\.dirty\s*=|postMessage|hostSerialized/);
  expect(adapter).toContain("impl NativeHostAdapter for PdfCraftApp");
  expect(adapter).toContain("native_host: Option<NativeHostFrame>");
  expect(adapter.indexOf("host.note_input(&self.app, raw)")).toBeLessThan(
    adapter.indexOf("eframe::App::raw_input_hook(&mut self.app, ctx, raw)"),
  );
  expect(adapter.indexOf("host.before_logic(&mut self.app, ctx)")).toBeLessThan(
    adapter.indexOf("eframe::App::logic(&mut self.app, ctx, frame)"),
  );
  expect(adapter.indexOf("host.after_logic(&mut self.app, ctx)")).toBeGreaterThan(
    adapter.indexOf("eframe::App::logic(&mut self.app, ctx, frame)"),
  );
  expect(adapter.indexOf("host.after_ui(&mut self.app, ui.ctx())")).toBeGreaterThan(
    adapter.indexOf("eframe::App::ui(&mut self.app, ui, frame)"),
  );
  expect(adapter).toContain("eframe::App::save(&mut self.app, storage)");
  expect(adapter).not.toMatch(/wrapping_add|postMessage|KeyboardEvent|NativeHostClock/);
  expect(() => patchPdfNativeHookup(new Map())).toThrow("stage");
});

test.skipIf(!inputs.ARTCRAFT_TEST_PDF_ARCHIVE)(
  "PDF exact source-map wrapper preserves export options and delays native save continuation until host acknowledgement",
  async () => {
    const pin = pins.editors.find((entry) => entry.app === "pdfcraft")!;
    const archive = await readFile(inputs.ARTCRAFT_TEST_PDF_ARCHIVE!);
    expect(sha256(archive)).toBe(pin.sourceSha256);

    const original = readGitSourceArchive(
      archive,
      "pdfcraft-0.17.0",
      "7d78f3e14474b978be014715e0cc64895d77025a",
    );

    const authoredInputs = await authored();
    const stage = patchNativeMethods(original, "pdfcraft", authoredInputs).files;
    const before = new Map([...stage].map(([path, bytes]) => [path, sha256(bytes)]));
    const result = patchPdfNativeHookup(stage);
    expect(() =>
      execFileSync(
        "rustfmt",
        ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
        {
          input: stage.get("crates/ui-egui/src/editing/native_host.rs"),
          maxBuffer: 4 * 1024 * 1024,
        },
      ),
    ).not.toThrow();

    expect(result.changes.length).toBe(7);
    expect(result.files.get("apps/pdfcraft-web/src/native_frame.rs")).toEqual(authoredInputs.frame);
    expect(result.files.has("apps/pdfcraft-web/src/native_host.rs")).toBe(false);
    const web = result.files.get("apps/pdfcraft-web/src/main.rs")!.toString();

    expect(web).toContain('NativeHostFrame::prepare("pdfcraft", NATIVE_ARTIFACT_VERSION)');
    expect(web).toContain("native_frame::NativeWebApp::new(app, &cc.egui_ctx)?");
    expect(web).not.toMatch(
      /mod host\s*\{|bridge\.listen|bridge\.save_fn|bridge\.post_ready|host::Bridge/,
    );
    expect(web.indexOf("NativeHostFrame::ready()")).toBeGreaterThan(web.indexOf(".await;"));
    expect(web).toContain("if let Some(url) = None::<String> { // Hyori: no `?file=` URL intake");
    expect(web).not.toContain('query_param("file")');
    expect(web).toContain("warn_before_unload(app.unsaved_flag.clone())");
    const save = result.files.get("crates/ui-egui/src/editing/save.rs")!.toString();

    expect(
      save.indexOf("return self.native_host_save_then(index, target, Box::new(after))"),
    ).toBeLessThan(save.indexOf("!self.commit_typing_in(id)"));
    expect(
      save.indexOf("return self.native_host_save_then(index, target, Box::new(after))"),
    ).toBeLessThan(save.indexOf("self.session.mark_saved(id"));
    const files = result.files.get("crates/ui-egui/src/app/files.rs")!.toString();

    expect(files).toContain("self.native_host_cancel_open(&p.bytes)");
    expect(files).toContain("self.native_host_password_opened(&native_host_source)");
    expect(files.indexOf("let native_host_source = p.bytes.clone()")).toBeLessThan(
      files.indexOf("match self.try_open(&p.name, p.path, p.bytes, Some(&pw), p.activate)"),
    );
    expect(result.files.get("crates/ui-egui/src/workflows/export_ui.rs")).toEqual(
      original.get("crates/ui-egui/src/workflows/export_ui.rs"),
    );
    expect(result.files.get("crates/ui-egui/src/editing/close.rs")).toEqual(
      original.get("crates/ui-egui/src/editing/close.rs"),
    );
    expect(result.files.get("crates/engine/src/session/save.rs")).toEqual(
      original.get("crates/engine/src/session/save.rs"),
    );

    for (const [path, bytes] of stage) {
      expect(sha256(bytes)).toBe(before.get(path));

      if (!result.changes.some((change) => change.path === path))
        expect(result.files.get(path)).toEqual(bytes);
    }

    for (const change of result.changes) {
      expect(change.before).toBe(before.get(change.path) ?? null);
      expect(change.after).toBe(sha256(result.files.get(change.path)!));
      expect(() =>
        execFileSync(
          "rustfmt",
          ["--edition", "2024", "--config", "skip_children=true", "--emit", "stdout"],
          { input: result.files.get(change.path), maxBuffer: 4 * 1024 * 1024 },
        ),
      ).not.toThrow();
    }

    expect(() => patchPdfNativeHookup(result.files)).toThrow("second");
    expect(() => patchPdfNativeHookup(original)).toThrow("stage");

    for (const path of result.changes
      .filter((change) => change.before)
      .map((change) => change.path)) {
      const missing = new Map(stage);
      missing.delete(path);
      expect(() => patchPdfNativeHookup(missing)).toThrow();
      const changed = new Map(stage);
      changed.set(
        path,
        Buffer.concat([stage.get(path)!, Buffer.from("\n// unexpected source drift\n")]),
      );
      expect(() => patchPdfNativeHookup(changed)).toThrow();
    }

    const duplicate = new Map(stage);
    duplicate.set(
      "crates/ui-egui/src/editing.rs",
      Buffer.concat([
        stage.get("crates/ui-egui/src/editing.rs")!,
        Buffer.from("\nmod native_host;\npub use native_host::{NativeHostJob};\n"),
      ]),
    );
    expect(() => patchPdfNativeHookup(duplicate)).toThrow("duplicated");
    const staleJobs = new Map(stage);
    staleJobs.set(
      "crates/ui-egui/src/editing/native_host.rs",
      Buffer.from("pub struct NativeHostJob;"),
    );
    expect(() => patchPdfNativeHookup(staleJobs)).toThrow("stage");
  },
  120000,
);

import { readFileSync } from "node:fs";
import { sha256 } from "./evidence-bytes.ts";

const patchRoot = new URL("../../tooling/artcraft/patches/native-host-v3/", import.meta.url);

const originals = new Map([
  [
    "crates/ui-egui/src/ribbon/title_bar.rs",
    "adae16c2446caf8656aec607a980168ce2bfb8d0155ab0d92c5bdaba8bb9f6dd",
  ],
  [
    "crates/ui-egui/src/backstage/options.rs",
    "bcea45ccab631f0569d9feaf08c793f3d2519a5d99931fdc29b254ba4fef71db",
  ],
  ["crates/ui-egui/src/lib.rs", "b772378261ece484646d3cc6195a0a81f2b58ef15fa38b7a1be07258ea3f2262"],
  ["crates/ui-egui/src/app.rs", "b91d010b39aa22433737d386eaf4707048aeac3cc25249ee1ad8dd135cdef494"],
  [
    "crates/ui-egui/src/app/commands.rs",
    "ae536a06973c34784265be34eb15546224a644189a28dad965211271b8845c96",
  ],
  [
    "crates/ui-egui/src/app/quit.rs",
    "03e8112752d4c2ed445593f8f6e81f579b998e9943754b3bcbbd78bf76dae935",
  ],
  [
    "crates/ui-egui/src/app/files.rs",
    "4f3f3dbb6ac2fcd5fe93a1ff3072f02192b80bad99c682fa6e4be257cd42345d",
  ],
  [
    "crates/ui-egui/src/dialogs.rs",
    "4407d50a3d4619ec00db436de8251755ac1028033d4e64e8aa90f92618448660",
  ],
  [
    "crates/ui-egui/src/dialogs/show.rs",
    "d4effbec42077c377cf5d2b3c5f92fe6a7e230fac75dd698e567369b56b5b837",
  ],
  [
    "apps/gridcraft-web/src/main.rs",
    "a913d8a90011376caee4df9fe7a02c3bd93920ca498237067eaaf8e9d01892d3",
  ],
  [
    "apps/gridcraft-web/src/web.rs",
    "f454cfa641a236c250f8e9b07acca89708c3a252bb0eda8f92c308d26ebf927a",
  ],
]);

const sharedStage = new Map([
  ["crates/ui-egui/src/app.rs", /\nmod native_host;\npub use native_host::\{[^\n]+\};/gu],
  ["crates/ui-egui/src/lib.rs", /\npub use app::\{[^\n]+\};/gu],
]);

/** Exact 0.15.0 source after the shared methods+intents+jobs stage, before marks/palette composition. */
export function patchGridNativeHookup(source: ReadonlyMap<string, Buffer>) {
  const framePath = "apps/gridcraft-web/src/native_frame.rs";
  const module = source.get("crates/ui-egui/src/app/native_host.rs");
  const methods = readFileSync(new URL("grid-native.rs", patchRoot));
  const jobs = readFileSync(new URL("grid-jobs.rs", patchRoot));

  if (source.has(framePath)) throw new Error("Refusing a second Grid native hookup application");

  if (
    !module ||
    !module.includes(methods) ||
    !module.subarray(-jobs.length).equals(jobs) ||
    !module.includes(Buffer.from("pub struct NativeHostJob"))
  )
    throw new Error("Grid hookup requires the exact authored shared methods/intents/jobs stage");

  for (const [path, expected] of originals) {
    let text = source.get(path)?.toString();

    if (text === undefined) throw new Error(`Grid native source missing: ${path}`);

    const stage = sharedStage.get(path);

    if (stage) {
      if ([...text.matchAll(stage)].length !== 1)
        throw new Error(`Grid shared stage missing/duplicated: ${path}`);
      text = text.replace(stage, "");
    }

    if (sha256(Buffer.from(text)) !== expected)
      throw new Error(`Grid native source drift: ${path}`);
  }

  const files = new Map(source);

  function replace(path: string, before: string, after: string, count = 1) {
    const body = files.get(path);

    if (!body) throw new Error(`Grid native source missing: ${path}`);

    const text = body.toString();

    if (text.split(before).length - 1 !== count)
      throw new Error(`Grid native anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replaceAll(before, after)));
  }

  replace(
    "crates/ui-egui/src/lib.rs",
    "pub struct SheetApp {\n    pub session: Session,",
    `pub struct SheetApp {
    pub(crate) native_host_intents: Option<NativeHostIntentFn>,
    pub(crate) native_host_job: Option<NativeHostJob>,
    pub(crate) native_host_open_pending: Option<app::NativeHostPendingOpen>,
    pub session: Session,`,
  );
  replace(
    "crates/ui-egui/src/app.rs",
    "mod native_host;",
    "mod native_host;\npub(crate) use native_host::NativeHostPendingOpen;",
  );
  replace(
    "crates/ui-egui/src/app.rs",
    "        SheetApp {\n            session,",
    `        SheetApp {
            native_host_intents: None,
            native_host_job: None,
            native_host_open_pending: None,
            session,`,
  );
  replace(
    "crates/ui-egui/src/app/commands.rs",
    "    pub(super) fn run_command(&mut self, id: &str, params: Json) -> Result<Json, String> {",
    `    pub(super) fn run_command(&mut self, id: &str, params: Json) -> Result<Json, String> {
        if let Some(result) = self.native_host_command(id, &params) { return result; }`,
  );
  replace(
    "crates/ui-egui/src/app/quit.rs",
    "    pub fn answer_save_changes(&mut self, answer: SaveAnswer, quitting: bool, ctx: &egui::Context) -> bool {",
    `    pub fn answer_save_changes(&mut self, answer: SaveAnswer, quitting: bool, ctx: &egui::Context) -> bool {
        if let Some(result) = self.native_host_save_changes(answer, quitting, ctx) { return result; }`,
  );
  replace(
    "crates/ui-egui/src/app/files.rs",
    "    pub(super) fn autosave(&mut self, ctx: &egui::Context) {",
    `    pub(super) fn autosave(&mut self, ctx: &egui::Context) {
        if self.native_host_intents.is_some() { return; }`,
  );
  replace(
    "crates/ui-egui/src/dialogs.rs",
    "pub struct Dialog {",
    "pub struct Dialog {\n    pub(crate) native_host_open: Option<std::sync::Arc<()>>,",
  );
  replace(
    "crates/ui-egui/src/dialogs.rs",
    "        Dialog {\n            name: name.into(),",
    "        Dialog {\n            native_host_open: None,\n            name: name.into(),",
    2,
  );
  replace(
    "crates/ui-egui/src/dialogs/show.rs",
    "                    app.after_open(path.as_deref(), &r);",
    "                    app.after_open(path.as_deref(), &r);\n                    app.native_host_password_opened(d.native_host_open.as_ref());",
  );
  replace("apps/gridcraft-web/src/main.rs", "mod host;", "mod native_host;\nmod native_frame;");

  const titleToggle = `            // AutoSave toggle (saves after each change when the workbook has a file).
            ui.label(egui::RichText::new(app.ui.language.tr("AutoSave")).font(theme::ui_font(12.5)).color(t.text_dim));
            let on = app.ui.autosave;
            let (r, resp) = ui.allocate_exact_size(vec2(30.0, 16.0), Sense::click());
            ui.painter().rect_filled(r, 8.0, if on { t.accent } else { Color32::TRANSPARENT });
            ui.painter().rect_stroke(r, 8.0, Stroke::new(1.0, if on { t.accent } else { t.text_dim }), StrokeKind::Inside);
            let knob = if on { pos2(r.right() - 8.0, r.center().y) } else { pos2(r.left() + 8.0, r.center().y) };
            ui.painter().circle_filled(knob, 5.0, if on { t.on_accent } else { t.text_dim });
            if resp.on_hover_text(app.ui.language.tr("AutoSave: save after every change (workbooks saved to a file)")).clicked() {
                app.toggle_autosave();
            }`;

  replace(
    "crates/ui-egui/src/ribbon/title_bar.rs",
    titleToggle,
    `            if app.native_host_intents.is_some() {
                ui.label(egui::RichText::new("Saving managed by Hyori").font(theme::ui_font(12.5)).color(t.text_dim));
            } else {
${titleToggle}
            }`,
  );

  const optionsToggle = `    let mut autosave = app.ui.autosave;
    if ui.checkbox(&mut autosave, lang.tr("Save .xlsx workbooks automatically after every change")).changed() {
        app.toggle_autosave();
    }`;

  replace(
    "crates/ui-egui/src/backstage/options.rs",
    optionsToggle,
    `    if app.native_host_intents.is_some() {
        ui.label("Saving managed by Hyori");
    } else {
${optionsToggle}
    }`,
  );

  const web = "apps/gridcraft-web/src/web.rs";
  replace(
    web,
    "use gridcraft_ui_egui::{Inbox, Services, SheetApp};",
    "use gridcraft_ui_egui::{Inbox, Services, SheetApp};\nuse crate::native_host::{NativeHostFrame, NATIVE_ARTIFACT_VERSION};",
  );
  replace(
    web,
    "    wasm_bindgen_futures::spawn_local(async {",
    `    let hosted = match NativeHostFrame::prepare("gridcraft", NATIVE_ARTIFACT_VERSION) {
        Ok(hosted) => hosted,
        Err(error) => { crate::native_frame::report_failure(error); return; }
    };
    wasm_bindgen_futures::spawn_local(async move {`,
  );
  replace(
    web,
    `        let bridge = if query_param("host").as_deref() == Some("parent") { crate::host::Bridge::new() } else { None };
        let app_bridge = bridge.clone();`,
    "",
  );
  replace(web, "let q = if app_bridge.is_some() {", "let q = if hosted {");
  // A sandboxed frame can't show a PDF at all; hosted print downloads it instead.
  replace(
    web,
    "fn print_pdf(bytes: &[u8]) -> Result<(), String> {\n",
    "fn print_pdf(bytes: &[u8]) -> Result<(), String> {\n    if crate::native_host::show_pdf(bytes)? { return Ok(()); }\n",
  );
  replace(
    web,
    `                    let mut services = services(inbox.clone(), cc.egui_ctx.clone());
                    if let Some(bridge) = &app_bridge {
                        bridge.connect(&mut services, inbox.clone(), cc.egui_ctx.clone());
                    }`,
    "                    let services = services(inbox.clone(), cc.egui_ctx.clone());",
  );
  replace(
    web,
    `                    if let Some(bridge) = &app_bridge {
                        prefs.keep_user_name(app.session.prefs.user_name.clone());
                        if let Some(author) = query_param("author") {
                            crate::host::Bridge::set_author(&mut app, &author);
                        }
                        bridge.post_ready();
                    }
                    Ok(Box::new(WebShell { app, inbox, bridge: app_bridge, prefs }))`,
    `                    if hosted {
                        prefs.keep_user_name(app.session.prefs.user_name.clone());
                        if let Some(author) = query_param("author") {
                            let author: String = author.trim().chars().take(200).collect();
                            if !author.is_empty() { app.session.prefs.user_name = author; }
                        }
                    }
                    let native_host = NativeHostFrame::new(&cc.egui_ctx, &mut app)?;
                    Ok(Box::new(WebShell { app, inbox, native_host, prefs }))`,
  );
  replace(
    web,
    `        if let (Err(e), Some(bridge)) = (&result, &bridge) {
            bridge.post_failed(&format!("{e:?}"));
        }`,
    `        match &result {
            Ok(()) => { if let Err(error) = NativeHostFrame::ready() { crate::native_frame::report_failure(error); } }
            Err(error) => { let _ = NativeHostFrame::failed(&format!("{error:?}")); }
        }`,
  );
  replace(
    web,
    "    bridge: Option<crate::host::Bridge>,",
    "    native_host: Option<NativeHostFrame>,",
  );
  replace(
    web,
    "        self.app.logic(ctx);",
    `        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.before_logic(&mut self.app, ctx) { crate::native_frame::report_failure(error); }
        self.app.logic(ctx);
        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.after_logic(&mut self.app, ctx) { crate::native_frame::report_failure(error); }`,
  );
  replace(
    web,
    "        self.app.raw_input_hook(ctx, raw);",
    `        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.note_input(&self.app, raw) { crate::native_frame::report_failure(error); }
        self.app.raw_input_hook(ctx, raw);`,
  );
  replace(
    web,
    `        if let Some(bridge) = &self.bridge {
            bridge.sync(&mut self.app);
        }`,
    `        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.after_ui(&mut self.app, ui.ctx()) { crate::native_frame::report_failure(error); }`,
  );
  files.set(framePath, readFileSync(new URL("grid-frame.rs", patchRoot)));

  const changes = [...files].flatMap(([path, body]) => {
    const before = source.get(path);

    return before?.equals(body)
      ? []
      : [{ path, before: before ? sha256(before) : null, after: sha256(body) }];
  });

  return { files, changes };
}

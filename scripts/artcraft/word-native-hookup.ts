import { sha256 } from "./evidence-bytes.ts";

/** Pure source overlay; shared methods/jobs/frame composition must already exist. */
export function patchWordNativeHookup(source: ReadonlyMap<string, Buffer>, frame: Buffer) {
  const files = new Map(source);
  const ui = "crates/ui-egui/src";
  const web = "apps/wordcraft-web/src";

  if (!source.get(`${ui}/app/native_host.rs`)?.includes(Buffer.from("native_host_capture_intent")))
    throw new Error("Word hookup requires composed shared types and native job methods");

  function replace(path: string, before: string, after: string) {
    const body = files.get(path);

    if (!body) throw new Error(`Missing Word native source: ${path}`);
    const text = body.toString();
    const first = text.indexOf(before);

    if (first < 0 || text.indexOf(before, first + before.length) >= 0)
      throw new Error(`Word native anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replace(before, after)));
  }

  replace(
    `${ui}/lib.rs`,
    "    pub services: Services,",
    "    pub services: Services,\n    pub(crate) native_host_intents: Option<crate::NativeHostIntentFn>,\n    pub(crate) native_host_job: Option<crate::NativeHostJob>,",
  );
  replace(
    `${ui}/window_ui.rs`,
    "            services: _,\n",
    "            services: _,\n            native_host_intents: _,\n            native_host_job: _,\n",
  );
  replace(
    `${ui}/app.rs`,
    "            services,\n            printing:",
    "            services,\n            native_host_intents: None,\n            native_host_job: None,\n            printing:",
  );

  replace(
    `${ui}/chrome.rs`,
    "                // AutoSave switch: greyed out, with the reason as its tooltip, when AutoSave can't",
    `                if app.native_host_intents.is_some() {
                    ui.add(egui::Label::new(egui::RichText::new("Cloud saving managed by Hyori").font(regular(11.5)).color(t.text_dim)).selectable(false));
                } else {
                // AutoSave switch: greyed out, with the reason as its tooltip, when AutoSave can't`,
  );
  replace(
    `${ui}/chrome.rs`,
    "                ui.add_space(8.0);\n                // Hidden (#1945)",
    "                }\n                ui.add_space(8.0);\n                // Hidden (#1945)",
  );
  replace(
    `${ui}/app/commands.rs`,
    '        if id == "file.autosave" {',
    '        if id == "file.autosave" && self.native_host_intents.is_some() {\n            return Err("Cloud saving managed by Hyori".into());\n        }\n        if id == "file.autosave" {',
  );

  const intent = `        // Native cloud capture owns durability; never reach the old download-clean path.
        if self.native_host_intents.is_some() && matches!(id, "file.save" | "file.saveAs" | "file.exportPdf" | "file.exportPng") {
            let save_as = id != "file.save";
            let name = if save_as {
                let name = params.get("path").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| self.web_save_name(id));
                Some(if id == "file.exportPdf" && !name.ends_with(".pdf") { format!("{name}.pdf") } else { name })
            } else { None };
            let options = params.clone();
            let native_save = matches!(id, "file.save" | "file.saveAs");
            let serialize: crate::NativeHostSerializer = Box::new(move |app, document, name, reason| {
                app.native_host_serialize_options(document, name, reason, &options, native_save)
            });
            if self.native_host_begin_intent(save_as, name, Some(serialize), None).map_err(|error| error.to_string())? {
                return Ok(json!({"pending": "nativeHostSave"}));
            }
            // Explicit unsupported exports retain their existing local pipeline and settings.
        }
`;

  replace(
    `${ui}/app/commands.rs`,
    "        // Web: saving and exporting become downloads.",
    `${intent}        // Web: saving and exporting become downloads.`,
  );

  replace(
    `${ui}/file_dialogs.rs`,
    "    pub fn save_as_dialog(&mut self) {",
    `    pub fn save_as_dialog(&mut self) {
        // Browse is a copy request; the web picker otherwise turns it into file.save(path).
        // Do not infer this from path: ordinary Save commands can carry a path too.
        if self.native_host_intents.is_some() {
            let name = self.default_save_name();
            if let Err(error) = self.native_host_begin_intent(true, Some(name), None, None) {
                self.status(error.to_string());
            }
            return;
        }`,
  );

  const continuation = `        if choice == SaveChoice::Save && self.native_host_intents.is_some() {
            let retry_then = then.clone();
            let retry_params = params.clone();
            let continuation: crate::NativeHostContinuation = Box::new(move |app| {
                if let Err(error) = app.execute_held_back(&then, params) { app.status(error); }
            });
            return match self.native_host_begin_intent(false, None, None, Some(continuation)) {
                Ok(true) => Ok(json!({"pending": "nativeHostSave"})),
                Ok(false) => Err(self.save_failed("Cloud replacement cannot fall back to a local download", retry_then, retry_params, document)),
                Err(error) => Err(self.save_failed(&error.to_string(), retry_then, retry_params, document)),
            };
        }
`;

  replace(
    `${ui}/app/files.rs`,
    "        let go = match choice {",
    `${continuation}        let go = match choice {`,
  );

  replace(
    `${web}/main.rs`,
    "mod host;",
    'mod native_host;\n#[cfg(target_arch = "wasm32")]\nmod native_frame;',
  );
  replace(
    `${web}/web.rs`,
    '        let bridge = if query_param("host").as_deref() == Some("parent") { crate::host::Bridge::new() } else { None };\n        let app_bridge = bridge.clone();',
    `        let native_host = match crate::native_host::NativeHostFrame::prepare("wordcraft", crate::native_host::NATIVE_ARTIFACT_VERSION) {
            Ok(active) => active,
            Err(error) => { log::error!("native host preparation: {error}"); return; }
        };`,
  );
  replace(`${web}/web.rs`, "        if bridge.is_none()", "        if !native_host");
  replace(
    `${web}/web.rs`,
    '                    let sample = app_bridge.is_none() && query().contains("sample");',
    '                    let sample = !native_host && query().contains("sample");',
  );
  replace(
    `${web}/web.rs`,
    "                    let mut services = services(inbox.clone(), cc.egui_ctx.clone(), dirty, saves.clone(), messages.clone());\n                    if let Some(bridge) = &app_bridge {\n                        bridge.connect(&mut services, inbox.clone(), cc.egui_ctx.clone());\n                    }",
    "                    let services = services(inbox.clone(), cc.egui_ctx.clone(), dirty, saves.clone(), messages.clone());",
  );
  replace(
    `${web}/web.rs`,
    "                    if app_bridge.is_some()",
    "                    if native_host",
  );
  replace(
    `${web}/web.rs`,
    "                        crate::host::Bridge::set_author(&mut app, &author);",
    "                        crate::native_frame::set_author(&mut app, &author);",
  );
  replace(
    `${web}/web.rs`,
    "                    Ok(Box::new(WebShell { app, inbox, messages, prefs }))",
    `                    let native_host = crate::native_host::NativeHostFrame::new(&cc.egui_ctx, &mut app)
                        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
                    Ok(Box::new(WebShell { app, inbox, messages, prefs, native_host }))`,
  );
  replace(
    `${web}/web.rs`,
    `        if let Some(bridge) = &bridge {
            match &result {
                Ok(()) => bridge.post_ready(),
                Err(e) => bridge.post_failed(&format!("{e:?}")),
            }
        }`,
    `        if native_host {
            let posted = match &result {
                Ok(()) => crate::native_host::NativeHostFrame::ready(),
                Err(error) => crate::native_host::NativeHostFrame::failed(&format!("{error:?}")),
            };
            if let Err(error) = posted { log::error!("native host startup: {error}"); }
        }`,
  );
  replace(
    `${web}/web.rs`,
    "    prefs: crate::prefs::PrefsSync,",
    "    prefs: crate::prefs::PrefsSync,\n    native_host: Option<crate::native_host::NativeHostFrame>,",
  );

  const report = (method: string, context: string) =>
    `        if let Some(host) = self.native_host.as_mut()\n            && let Err(error) = host.${method}(&mut self.app, ${context})\n        { self.app.status(error.to_string()); }\n`;

  replace(
    `${web}/web.rs`,
    "        self.app.logic(ctx);",
    `${report("before_logic", "ctx")}        self.app.logic(ctx);\n${report("after_logic", "ctx")}`,
  );
  replace(
    `${web}/web.rs`,
    "        self.app.raw_input_hook(ctx, raw);",
    `${report("note_input", "raw")}        self.app.raw_input_hook(ctx, raw);`,
  );
  replace(
    `${web}/web.rs`,
    "        self.app.ui(ui);",
    `        self.app.ui(ui);\n${report("after_ui", "ui.ctx()")}`,
  );

  const module = `${web}/native_frame.rs`;

  if (source.has(module)) throw new Error("Refusing to replace Word native adapter");
  files.set(module, frame);

  const changes = [...files].flatMap(([path, body]) => {
    const original = source.get(path);

    return original?.equals(body)
      ? []
      : [{ path, before: original ? sha256(original) : null, after: sha256(body) }];
  });

  return { files, changes, stage: "word-native-hookup-source-only-not-compiled" as const };
}

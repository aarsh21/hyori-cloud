import { sha256 } from "./evidence-bytes.ts";

/** Compose over the retained Deck host-engine source base, never edit its frozen patcher. */
export function patchDeckNativeHookup(source: ReadonlyMap<string, Buffer>, frame: Buffer) {
  const files = new Map(source);
  const ui = "crates/ui-egui/src";
  const web = "apps/deckcraft-web/src";

  if (!source.get(`${ui}/app/native_host.rs`)?.includes(Buffer.from("native_host_capture_intent")))
    throw new Error("Deck hookup requires composed shared types and native job methods");

  function replace(path: string, before: string, after: string) {
    const body = files.get(path);

    if (!body) throw new Error(`Missing Deck native source: ${path}`);
    const text = body.toString();
    const first = text.indexOf(before);

    if (first < 0 || text.indexOf(before, first + before.length) >= 0)
      throw new Error(`Deck native anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replace(before, after)));
  }

  replace(`${ui}/lib.rs`, "    pub services: Services,", "    pub services: Services,\n    pub(crate) native_host_intents: Option<crate::NativeHostIntentFn>,\n    pub(crate) native_host_job: Option<crate::NativeHostJob>,");
  replace(`${ui}/app.rs`, "            services,", "            services,\n            native_host_intents: None,\n            native_host_job: None,");
  replace(`${ui}/app/files.rs`, "    pub fn save(&mut self) {", `    pub fn save(&mut self) {
        if self.native_host_intents.is_some() {
            if let Err(error) = self.native_host_begin_intent(false, None, None, None) { self.set_status(error.to_string()); }
            return;
        }`);
  replace(`${ui}/app/files.rs`, "    pub fn save_as_dialog(&mut self, format: &str) {", `    pub fn save_as_dialog(&mut self, format: &str) {
        if self.native_host_intents.is_some() {
            let ext = if format == "pptx" { "pptx" } else { "deckcraft" };
            let name = self.suggested_name(ext);
            match self.native_host_begin_intent(true, Some(name), None, None) {
                Ok(true) => return,
                Ok(false) => {}, // Unsupported explicit local copy: preserve native download.
                Err(error) => { self.set_status(error.to_string()); return; }
            }
        }`);
  replace(`${ui}/app/commands.rs`, "        let r = if self.services.host_save.is_some() && id == \"file.save\" {", `        let r = if self.native_host_intents.is_some() && id == "file.save" {
            self.native_host_begin_intent(false, None, None, None).map_err(|error| error.to_string()).and_then(|handled| {
                if handled { Ok(json!({"pending": "nativeHostSave"})) } else { Err("Cloud replacement cannot become a local download".into()) }
            })
        } else if self.services.host_save.is_some() && id == "file.save" {`);

  replace(`${ui}/app/files.rs`, "        let suggested = self.suggested_name(ext);\n        if let Some(pick)", `        let suggested = self.suggested_name(ext);
        if self.native_host_intents.is_some() {
            let options = extra.clone();
            let serializer: crate::NativeHostSerializer = Box::new(move |app, document, name, reason| {
                app.native_host_serialize_options(document, name, reason, &options)
            });
            match self.native_host_begin_intent(true, Some(suggested.clone()), Some(serializer), None) {
                Ok(true) => { self.set_status("Waiting for cloud export persistence"); return true; }
                Ok(false) => {}, // PNG sequences/local exports retain the exact existing pipeline.
                Err(error) => { self.set_status(error.to_string()); return false; }
            }
        }
        if let Some(pick)`);
  replace(`${ui}/dialogs/body.rs`, "                app.save();\n                // In the browser a save is a download:", `                if app.native_host_intents.is_some() {
                    match app.native_host_close_after_save() {
                        Ok(true) => done = true,
                        Ok(false) => app.host_status("Cloud replacement cannot become a local download".into()),
                        Err(error) => app.host_status(error.to_string()),
                    }
                    return;
                }
                app.save();
                // In the browser a save is a download:`);

  replace(`${web}/main.rs`, "mod host;", "mod native_host;\n#[cfg(target_arch = \"wasm32\")]\nmod native_frame;");
  replace(`${web}/web.rs`, "use crate::host;\n", "");
  replace(`${web}/web.rs`, "        let mut options = eframe::WebOptions::default();", `        let native_host = match crate::native_host::NativeHostFrame::prepare("deckcraft", crate::native_host::NATIVE_ARTIFACT_VERSION) {
            Ok(active) => active,
            Err(error) => { log::error!("native host preparation: {error}"); return; }
        };
        let mut options = eframe::WebOptions::default();`);
  replace(`${web}/web.rs`, `let bridge = host::Bridge::new(&cc.egui_ctx).map_err(std::io::Error::other)?;
                    let mut platform = services(inbox.clone(), cc.egui_ctx.clone());
                    if let Some(bridge) = &bridge { bridge.connect(&mut platform); }
                    let mut app = SlideApp::new(Session::new(), platform);`, "let mut app = SlideApp::new(Session::new(), services(inbox.clone(), cc.egui_ctx.clone()));");
  replace(`${web}/web.rs`, "if bridge.is_none() {", "if !native_host {");
  replace(`${web}/web.rs`, "if bridge.is_none() && q.contains(\"show\") {", "if !native_host && q.contains(\"show\") {");
  replace(`${web}/web.rs`, "                    Ok(Box::new(WebShell { app, inbox, bridge }))", `                    let native_host = crate::native_host::NativeHostFrame::new(&cc.egui_ctx, &mut app)
                        .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })?;
                    Ok(Box::new(WebShell { app, inbox, native_host }))`);
  replace(`${web}/web.rs`, `        match &result {
            Ok(()) => host::Bridge::ready(),
            Err(error) => host::Bridge::failed(&format!("Editor initialization failed: {error:?}")),
        }`, `        if native_host {
            let posted = match &result {
                Ok(()) => crate::native_host::NativeHostFrame::ready(),
                Err(error) => crate::native_host::NativeHostFrame::failed(&format!("{error:?}")),
            };
            if let Err(error) = posted { log::error!("native host startup: {error}"); }
        }`);
  replace(`${web}/web.rs`, "    bridge: Option<host::Bridge>,", "    native_host: Option<crate::native_host::NativeHostFrame>,");
  const call = (method: string, context: string) => `        if let Some(host) = self.native_host.as_mut()\n            && let Err(error) = host.${method}(&mut self.app, ${context})\n        { self.app.host_status(error.to_string()); }`;
  replace(`${web}/web.rs`, "        if let Some(bridge) = &self.bridge { bridge.tick(&mut self.app); }", call("before_logic", "ctx"));
  replace(`${web}/web.rs`, "        self.app.logic(ctx);\n        if let Some(bridge) = &self.bridge { bridge.observe(&self.app); }", `        self.app.logic(ctx);\n${call("after_logic", "ctx")}`);
  replace(`${web}/web.rs`, "        self.app.ui(ui);\n        if let Some(bridge) = &self.bridge { bridge.observe(&self.app); }", `        self.app.ui(ui);\n${call("after_ui", "ui.ctx()")}`);
  replace(`${web}/web.rs`, "        // Browsers cannot read dropped files synchronously.", `${call("note_input", "raw")}\n        // Browsers cannot read dropped files synchronously.`);

  const module = `${web}/native_frame.rs`;

  if (source.has(module)) throw new Error("Refusing to replace Deck native adapter");
  files.set(module, frame);

  const changes = [...files].flatMap(([path, body]) => {
    const original = source.get(path);

    return original?.equals(body) ? [] : [{ path, before: original ? sha256(original) : null, after: sha256(body) }];
  });

  return { files, changes, stage: "deck-native-hookup-source-only-not-compiled" as const };
}

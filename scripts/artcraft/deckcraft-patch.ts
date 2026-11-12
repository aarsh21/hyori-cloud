import { sha256 } from "./evidence-bytes.ts";

export interface DeckPatchInputs {
  hostRust: Buffer;
  hostJavaScript: Buffer;
}

/** Fail closed on every upstream anchor; the caller first verifies the entire tagged archive. */
export function patchDeckCraft(original: Map<string, Buffer>, inputs: DeckPatchInputs) {
  const files = new Map(original);
  const changes: { path: string; before: string | null; after: string }[] = [];

  function replace(path: string, before: string, after: string) {
    const source = files.get(path)?.toString();

    if (!source || source.split(before).length !== 2)
      throw new Error(`Nonunique patch anchor: ${path}`);
    files.set(path, Buffer.from(source.replace(before, after)));
  }

  replace(
    "apps/deckcraft-web/src/main.rs",
    "mod web;",
    'mod web;\n\n#[cfg(target_arch = "wasm32")]\nmod host;',
  );
  const web = "apps/deckcraft-web/src/web.rs";
  replace(
    web,
    "use deckcraft_engine::Session;",
    "use crate::host;\nuse deckcraft_engine::Session;",
  );
  replace(
    web,
    "let mut app = SlideApp::new(Session::new(), services(inbox.clone(), cc.egui_ctx.clone()));",
    `let bridge = host::Bridge::new(&cc.egui_ctx).map_err(std::io::Error::other)?;
                    let mut platform = services(inbox.clone(), cc.egui_ctx.clone());
                    if let Some(bridge) = &bridge { bridge.connect(&mut platform); }
                    let mut app = SlideApp::new(Session::new(), platform);`,
  );
  replace(
    web,
    'if !q.contains("blank") {',
    'if bridge.is_none() {\n                    if !q.contains("blank") {',
  );
  replace(
    web,
    '                    if q.contains("show") {',
    '                    }\n                    if bridge.is_none() && q.contains("show") {',
  );
  replace(web, "WebShell { app, inbox }", "WebShell { app, inbox, bridge }");
  replace(
    web,
    "        if let Some(el) = document.get_element_by_id(LOADING_ID) {",
    `        match &result {
            Ok(()) => host::Bridge::ready(),
            Err(error) => host::Bridge::failed(&format!("Editor initialization failed: {error:?}")),
        }
        if let Some(el) = document.get_element_by_id(LOADING_ID) {`,
  );
  replace(web, "    inbox: Inbox,\n}", "    inbox: Inbox,\n    bridge: Option<host::Bridge>,\n}");
  replace(
    web,
    "        self.app.logic(ctx);",
    "        if let Some(bridge) = &self.bridge { bridge.tick(&mut self.app); }\n        self.app.logic(ctx);\n        if let Some(bridge) = &self.bridge { bridge.observe(&self.app); }",
  );
  replace(
    web,
    "        self.app.ui(ui);",
    "        self.app.ui(ui);\n        if let Some(bridge) = &self.bridge { bridge.observe(&self.app); }",
  );

  replace(
    "crates/ui-egui/src/services.rs",
    "    pub download: Option<DownloadFn>,",
    `    pub download: Option<DownloadFn>,
    /// Serialized output queued for host persistence; completion is explicitly acknowledged.
    pub host_save: Option<Box<dyn FnMut(&deckcraft_engine::DocState, &str, &[u8], bool) -> Result<(), String>>>,`,
  );
  const ui = "crates/ui-egui/src/app/files.rs";
  replace(
    ui,
    "impl SlideApp {",
    `impl SlideApp {
    /// Use the existing status surface without claiming browser delivery is persistence.
    pub fn host_status(&mut self, message: String) { self.set_status(message); }

    pub(super) fn queue_host_save(&mut self, format: Option<&str>, save_as: bool) -> Result<(), String> {
        let d = self.session.active().ok_or("No host presentation is open")?;
        let name = match format {
            Some(ext) => format!("{}.{}", d.title(), ext),
            None => d.path.clone().ok_or("No host output filename")?,
        };
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "deckcraft" | "pptx") { return Err("Unsupported host document format".into()); }
        let bytes = deckcraft_engine::cmd::file::save_bytes(&d.doc, &ext).map_err(|e| e.to_string())?;
        let send = self.services.host_save.as_mut().ok_or("No host save capability")?;
        send(d, &name, &bytes, save_as)?;
        self.set_status("Waiting for host persistence acknowledgement");
        Ok(())
    }
`,
  );
  replace(
    ui,
    "    pub fn save(&mut self) {",
    `    pub fn save(&mut self) {
        if self.services.host_save.is_some() {
            if let Err(error) = self.queue_host_save(None, false) { self.set_status(error); }
            return;
        }`,
  );
  replace(
    ui,
    "    pub fn save_as_dialog(&mut self, format: &str) {",
    `    pub fn save_as_dialog(&mut self, format: &str) {
        if self.services.host_save.is_some() {
            if let Err(error) = self.queue_host_save(Some(format), true) { self.set_status(error); }
            return;
        }`,
  );
  replace(
    ui,
    "        match (bytes, self.services.download.as_mut()) {",
    `        if self.services.host_save.is_some() {
            let result = (|| {
                let bytes = bytes.map_err(|error| error.to_string())?;
                let d = self.session.active().ok_or("No host presentation is open")?;
                let send = self.services.host_save.as_mut().ok_or("No host save capability")?;
                send(d, name, &bytes, true)
            })();
            match result {
                Ok(()) => { self.set_status("Waiting for host persistence acknowledgement"); return true; }
                Err(error) => { self.set_status(error); return false; }
            }
        }
        match (bytes, self.services.download.as_mut()) {`,
  );
  replace(
    "crates/ui-egui/src/app/commands.rs",
    "        let r = if UI_COMMANDS.iter().any(|c| c.0 == id) {",
    `        let r = if self.services.host_save.is_some() && id == "file.save" {
            self.queue_host_save(None, false).map(|_| json!({"pendingHostPersistence": true}))
        } else if self.services.host_save.is_some() && matches!(id, "file.saveAs" | "file.saveTemplate") {
            Err("Use the host Save As action rather than a filesystem path".into())
        } else if UI_COMMANDS.iter().any(|c| c.0 == id) {`,
  );
  replace(
    "crates/engine/src/lib.rs",
    "    pub fn active_mut(&mut self) -> Option<&mut DocState> {",
    `    /// Acknowledge exactly the serialized document snapshot, not subsequent edits or selection.
    pub fn mark_host_saved(&mut self, uid: u64, snapshot: Arc<Presentation>) -> bool {
        if let Some(document) = self.docs.iter_mut().find(|document| document.uid == uid) {
            document.saved_doc = snapshot;
            true
        } else { false }
    }

    pub fn active_mut(&mut self) -> Option<&mut DocState> {`,
  );
  replace(
    "crates/engine/src/cmd/file.rs",
    "/// What a file lost on opening.",
    `/// Host attachments require matching format identity and refuse a known damaged import.
/// This does not establish lossless PPTX fidelity or decompression resource safety.
pub fn open_host_presentation(name: &str, bytes: &[u8]) -> Result<Presentation> {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let matches = match extension.as_str() {
        "deckcraft" => deckcraft_format::sniff(bytes),
        "pptx" => !deckcraft_format::sniff(bytes) && deckcraft_pptx::sniff(bytes),
        _ => false,
    };
    if !matches { return Err(EngineError::Other("Host filename and presentation format do not match".into())); }
    let (presentation, damage) = open_checked(name, bytes)?;
    if !damage.is_empty() { return Err(EngineError::Other("Host import contains damaged or missing media/slides; source replacement refused".into())); }
    Ok(presentation)
}

/// What a file lost on opening.`,
  );
  files.set("apps/deckcraft-web/src/host.rs", inputs.hostRust);
  files.set("apps/deckcraft-web/hyori-host.js", inputs.hostJavaScript);

  for (const [path, bytes] of files) {
    const before = original.get(path);

    if (!before || !bytes.equals(before))
      changes.push({ path, before: before ? sha256(before) : null, after: sha256(bytes) });
  }

  if (files.get("Cargo.lock")?.equals(original.get("Cargo.lock")!) !== true)
    throw new Error("Patch must preserve Cargo.lock");

  return { files, changes };
}

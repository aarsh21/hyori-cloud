import { readFileSync } from "node:fs";
import { sha256 } from "./evidence-bytes.ts";

const patchRoot = new URL("../../tooling/artcraft/patches/native-host-v3/", import.meta.url);

const originals = new Map([
  ["crates/ui-egui/src/lib.rs", "ff2bf9bf0fe96363d70b5fb3280a13fedb00dd99e8aed1cd548e7be74637328a"],
  [
    "crates/ui-egui/src/editing.rs",
    "e9ec9639449fee27f5c4ede063b37ae1a26b94e73fff1399d0de7e350dc9e86a",
  ],
  ["crates/ui-egui/src/app.rs", "f9331b42dfcd51ae04f8f6a02142a070387295d4f91cb126d551f10bae7da2c0"],
  [
    "crates/ui-egui/src/app/files.rs",
    "8b2d12f1850ea5ed1a40e3449905d39ac1fd78cc5ca4395ad0b0d9569e92dfa9",
  ],
  [
    "crates/ui-egui/src/editing/save.rs",
    "b82cd5f91c5c558dd9c951c15131edc262b465640f702b75e66ec34a8c4f5991",
  ],
  [
    "apps/pdfcraft-web/src/main.rs",
    "57b0116b7a8db753d3026c15b592cd9815f7e3d06f4080530cb0201ddf060b67",
  ],
]);

const sharedStage = new Map([
  ["crates/ui-egui/src/editing.rs", /\nmod native_host;\npub use native_host::\{[^\n]+\};/gu],
  ["crates/ui-egui/src/lib.rs", /\npub use editing::\{NativeHost[^\n]+\};/gu],
]);

/** Exact 0.17.0 source after the shared methods+intents+jobs stage, before marks/palette composition. */
export function patchPdfNativeHookup(source: ReadonlyMap<string, Buffer>) {
  const framePath = "apps/pdfcraft-web/src/native_frame.rs";
  const module = source.get("crates/ui-egui/src/editing/native_host.rs");
  const methods = readFileSync(new URL("pdf-native.rs", patchRoot));
  const jobs = readFileSync(new URL("pdf-jobs.rs", patchRoot));

  if (source.has(framePath)) throw new Error("Refusing a second PDF native hookup application");

  if (
    !module ||
    !module.includes(methods) ||
    !module.subarray(-jobs.length).equals(jobs) ||
    !module.includes(Buffer.from("pub struct NativeHostJob"))
  )
    throw new Error("PDF hookup requires the exact authored shared methods/intents/jobs stage");

  for (const [path, expected] of originals) {
    let text = source.get(path)?.toString();

    if (text === undefined) throw new Error(`PDF native source missing: ${path}`);

    const stage = sharedStage.get(path);

    if (stage) {
      if ([...text.matchAll(stage)].length !== 1)
        throw new Error(`PDF shared stage missing/duplicated: ${path}`);
      text = text.replace(stage, "");
    }

    if (sha256(Buffer.from(text)) !== expected) throw new Error(`PDF native source drift: ${path}`);
  }

  const files = new Map(source);

  function replace(path: string, before: string, after: string) {
    const body = files.get(path);

    if (!body) throw new Error(`PDF native source missing: ${path}`);

    const text = body.toString();
    const index = text.indexOf(before);

    if (index < 0 || text.indexOf(before, index + before.length) >= 0)
      throw new Error(`PDF native anchor missing/duplicated: ${path}: ${before}`);
    files.set(path, Buffer.from(text.replace(before, after)));
  }

  replace(
    "crates/ui-egui/src/lib.rs",
    "pub struct PdfCraftApp {",
    `pub struct PdfCraftApp {
    pub(crate) native_host_intents: Option<NativeHostIntentFn>,
    pub(crate) native_host_job: Option<NativeHostJob>,
    pub(crate) native_host_open_pending: Option<editing::NativeHostPendingOpen>,`,
  );
  replace(
    "crates/ui-egui/src/editing.rs",
    "mod native_host;",
    "mod native_host;\npub(crate) use native_host::NativeHostPendingOpen;",
  );
  replace(
    "crates/ui-egui/src/app.rs",
    "    pub fn new() -> Self {\n        Self {",
    `    pub fn new() -> Self {
        Self {
            native_host_intents: None,
            native_host_job: None,
            native_host_open_pending: None,`,
  );
  replace(
    "crates/ui-egui/src/editing/save.rs",
    "    pub(crate) fn save_then(&mut self, index: usize, target: SaveTarget, after: impl FnOnce(&mut Self) + Send + 'static) -> bool {",
    `    pub(crate) fn save_then(&mut self, index: usize, target: SaveTarget, after: impl FnOnce(&mut Self) + Send + 'static) -> bool {
        if self.native_host_intents.is_some() {
            return self.native_host_save_then(index, target, Box::new(after));
        }`,
  );
  replace(
    "crates/ui-egui/src/app/files.rs",
    "        let Some(pw) = password else {\n",
    "        let Some(pw) = password else {\n            self.native_host_cancel_open(&p.bytes);\n",
  );
  replace(
    "crates/ui-egui/src/app/files.rs",
    "        match self.try_open(&p.name, p.path, p.bytes, Some(&pw), p.activate) {",
    "        let native_host_source = p.bytes.clone();\n        match self.try_open(&p.name, p.path, p.bytes, Some(&pw), p.activate) {",
  );
  replace(
    "crates/ui-egui/src/app/files.rs",
    "            Ok(()) if self.password_prompt.is_none() => {",
    "            Ok(()) if self.password_prompt.is_none() => {\n                self.native_host_password_opened(&native_host_source);",
  );

  const web = "apps/pdfcraft-web/src/main.rs";
  replace(
    web,
    "    use pdfcraft_ui_egui::PdfCraftApp;",
    "    use pdfcraft_ui_egui::PdfCraftApp;\n    use crate::native_host::{NativeHostFrame, NATIVE_ARTIFACT_VERSION};",
  );
  replace(
    web,
    "    let options = eframe::WebOptions",
    `    let hosted = match NativeHostFrame::prepare("pdfcraft", NATIVE_ARTIFACT_VERSION) {
        Ok(hosted) => hosted,
        Err(error) => { native_frame::report_failure(error); return; }
    };
    let options = eframe::WebOptions`,
  );
  replace(web, "                Box::new(|cc| {", "                Box::new(move |cc| {");
  replace(
    web,
    '                    if let Some(url) = query_param("file") {',
    '                    if !hosted && let Some(url) = query_param("file") {',
  );
  replace(
    web,
    `                    if query_param("host").as_deref() == Some("parent")
                        && let Some(bridge) = host::Bridge::new()
                    {`,
    "                    if hosted {",
  );
  replace(
    web,
    `                        bridge.listen(app.startup_inbox.clone(), cc.egui_ctx.clone());
                        app.host_save = Some(bridge.save_fn());
                        app.host_dirty = Some(bridge.dirty_fn());
                        bridge.post_ready();
                    } else if query_param("host").as_deref() == Some("parent") {
                        eframe::web_sys::console::warn_1(
                            &"PdfCraft: ?host=parent needs a framing page on the same origin; saves download instead".into(),
                        );
                    }
                    Ok(Box::new(app))`,
    `                    }
                    Ok(Box::new(native_frame::NativeWebApp::new(app, &cc.egui_ctx)?))`,
  );
  replace(
    web,
    `        if let Err(e) = started {
            eframe::web_sys::console::error_1(&e);
            if query_param("host").as_deref() == Some("parent")
                && let Some(bridge) = host::Bridge::new()
            {
                bridge.post_failed(&e.as_string().unwrap_or_else(|| format!("{e:?}")));
            }
        }`,
    `        match started {
            Ok(()) => { if let Err(error) = NativeHostFrame::ready() { native_frame::report_failure(error); } }
            Err(error) => {
                eframe::web_sys::console::error_1(&error);
                let _ = NativeHostFrame::failed(&error.as_string().unwrap_or_else(|| format!("{error:?}")));
            }
        }`,
  );

  const body = files.get(web)?.toString();

  if (!body) throw new Error("PDF web owner disappeared");

  const begin = body.indexOf(
    "/// The `postMessage` bridge to a same-origin parent page. Messages are plain objects with a",
  );

  const end = body.indexOf('#[cfg(not(target_arch = "wasm32"))]\nfn main()', begin);

  if (begin < 0 || end < begin) throw new Error("PDF old host module boundary missing");
  replace(
    web,
    body.slice(begin, end),
    '#[cfg(target_arch = "wasm32")]\nmod native_host;\n#[cfg(target_arch = "wasm32")]\nmod native_frame;\n\n',
  );
  files.set(framePath, readFileSync(new URL("pdf-frame.rs", patchRoot)));

  const changes = [...files].flatMap(([path, bytes]) => {
    const before = source.get(path);

    return before?.equals(bytes)
      ? []
      : [{ path, before: before ? sha256(before) : null, after: sha256(bytes) }];
  });

  return { files, changes };
}

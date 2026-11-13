/// Retain the upstream entry point, but print this document rather than an inaccessible nested
/// opaque-origin srcdoc. Pictures stay alive until afterprint (or the next print) releases them.
#[cfg(target_arch = "wasm32")]
pub(crate) fn print_in_iframe(
    html: &str,
    urls: Vec<String>,
    failed: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ctx: Option<egui::Context>,
) -> Result<(), String> {
    #[wasm_bindgen::prelude::wasm_bindgen(module = "/hyori-pdf-print.js")]
    extern "C" {
        #[wasm_bindgen::prelude::wasm_bindgen(catch, js_name = printDocument)]
        fn print_document(html: &str) -> Result<js_sys::Promise, wasm_bindgen::JsValue>;
    }
    let printing = print_document(html).map_err(js_error)?;
    wasm_bindgen_futures::spawn_local(async move {
        if let Err(error) = wasm_bindgen_futures::JsFuture::from(printing).await {
            if let Ok(mut queue) = failed.lock() { queue.push(js_error(error)); }
            if let Some(ctx) = ctx { ctx.request_repaint(); }
        }
        revoke(&urls);
    });
    Ok(())
}

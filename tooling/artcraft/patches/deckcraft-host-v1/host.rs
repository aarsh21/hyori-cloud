//! Host byte transport for the separately versioned Hyori build. Cloud authorization,
//! revision conflicts and persistence remain in the owning SDK/backend capability.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use deckcraft_engine::{DocState, Session};
use deckcraft_ui_egui::{Services, SlideApp};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

const VERSION: &str = "0.14.1-hyori-host.1";
const MAX_BYTES: u32 = 64 * 1024 * 1024;

type SavedSnapshot = Box<dyn FnOnce(&mut Session)>;

struct Pending {
    id: String,
    apply: Option<SavedSnapshot>,
}

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    observed: Option<(u64, usize, bool)>,
}

#[derive(Clone)]
pub struct Bridge {
    state: Rc<RefCell<State>>,
}

#[wasm_bindgen::prelude::wasm_bindgen(module = "/hyori-host.js")]
extern "C" {
    #[wasm_bindgen(js_name = hostRequested)]
    fn requested() -> bool;
    #[wasm_bindgen(catch, js_name = initializeHost)]
    fn initialize(version: &str, repaint: &js_sys::Function) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostReady)]
    fn ready() -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeOpen)]
    fn take_open() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostOpened)]
    fn opened(id: &str, document: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostOpenFailed)]
    fn open_failed(id: &str, error: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostSave)]
    fn save(document: &str, name: &str, bytes: &[u8], save_as: bool) -> Result<String, JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeAcknowledgement)]
    fn take_ack() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostConfirmSaved)]
    fn confirm_saved(id: &str, dirty: bool) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostDirty)]
    fn dirty(value: bool) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostFailed)]
    fn failed(error: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostReportError)]
    fn report_error(error: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeLocalError)]
    fn take_error() -> Result<JsValue, JsValue>;
}

fn js_error(error: JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}

fn text(value: &JsValue, key: &str) -> Result<String, String> {
    js_sys::Reflect::get(value, &key.into())
        .map_err(js_error)?
        .as_string()
        .ok_or_else(|| format!("missing host field {key}"))
}

impl Bridge {
    pub fn new(ctx: &egui::Context) -> Result<Option<Self>, String> {
        if !requested() {
            return Ok(None);
        }
        let ctx = ctx.clone();
        let repaint = Closure::<dyn FnMut()>::new(move || ctx.request_repaint());
        if !initialize(VERSION, repaint.as_ref().unchecked_ref()).map_err(js_error)? {
            return Err("host attachment was not initialized".into());
        }
        // This callback has the page's lifetime, just like its message listener.
        repaint.forget();
        Ok(Some(Self { state: Rc::default() }))
    }

    pub fn connect(&self, services: &mut Services) {
        let bridge = self.clone();
        services.host_save = Some(Box::new(move |document, name, bytes, save_as| {
            bridge.post_save(document, name, bytes, save_as)
        }));
        // File/Open must not substitute a local picker for the cloud session's document.
        let mut picker = services.open_async.take();
        services.open_async = Some(Box::new(move |purpose, request| {
            if purpose == "open" {
                let _ = report_error("Open cloud documents through a fresh host attachment");
            } else if let Some(picker) = picker.as_mut() {
                picker(purpose, request);
            }
        }));
        services.write = None;
        services.download = None;
    }

    pub fn ready() {
        if !requested() { return; }
        if let Err(error) = ready() {
            log::error!("host ready: {}", js_error(error));
        }
    }

    pub fn failed(error: &str) {
        let _ = failed(error);
    }

    fn note_document(&self, document: &DocState) -> Result<(), String> {
        let signature = (document.uid, Arc::as_ptr(&document.doc) as usize, document.is_dirty());
        let changed = {
            let mut state = self.state.try_borrow_mut().map_err(|_| "host state is busy")?;
            let changed = state.observed != Some(signature);
            state.observed = Some(signature);
            changed
        };
        if changed {
            dirty(signature.2).map_err(js_error)?;
        }
        Ok(())
    }

    fn post_save(&self, document: &DocState, name: &str, bytes: &[u8], save_as: bool) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES as usize {
            return Err("serialized output exceeds the host byte bound".into());
        }
        self.note_document(document)?;
        let has_pending = self.state.try_borrow().map_err(|_| "host state is busy")?.pending.is_some();
        let id = save(&document.uid.to_string(), name, bytes, save_as).map_err(js_error)?;
        if has_pending {
            // Only a failed post may resend the same ID. Keep its original snapshot.
            return Ok(());
        }
        let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let apply: Option<SavedSnapshot> = if matches!(extension.as_str(), "deckcraft" | "pptx") {
            let snapshot = document.doc.clone();
            let uid = document.uid;
            Some(Box::new(move |session| { session.mark_host_saved(uid, snapshot); }))
        } else {
            // An exported copy is not a save of the editable presentation.
            None
        };
        self.state.try_borrow_mut().map_err(|_| "host state is busy")?.pending = Some(Pending { id, apply });
        Ok(())
    }

    pub fn tick(&self, app: &mut SlideApp) {
        if let Err(error) = self.apply_open(app) {
            app.host_status(error);
        }
        if let Err(error) = self.apply_ack(app) {
            app.host_status(error);
        }
        self.observe(app);
        if let Ok(error) = take_error()
            && let Some(error) = error.as_string()
        {
            app.host_status(error);
        }
    }

    fn apply_open(&self, app: &mut SlideApp) -> Result<(), String> {
        let message = take_open().map_err(js_error)?;
        if message.is_null() || message.is_undefined() {
            return Ok(());
        }
        let id = text(&message, "openId")?;
        let result = (|| {
            let name = text(&message, "name")?;
            let value = js_sys::Reflect::get(&message, &"bytes".into()).map_err(js_error)?;
            let array = value.dyn_into::<js_sys::Uint8Array>().map_err(|_| "invalid host byte view")?;
            if array.length() == 0 || array.length() > MAX_BYTES {
                return Err("host input exceeds the byte bound".into());
            }
            let bytes = array.to_vec();
            let presentation = deckcraft_engine::cmd::file::open_host_presentation(&name, &bytes).map_err(|error| error.to_string())?;
            deckcraft_engine::cmd::file::add_opened(&mut app.session, &name, Some(name.clone()), presentation);
            let document = app.session.active().ok_or("host document did not open")?;
            opened(&id, &document.uid.to_string()).map_err(js_error)
        })();
        if let Err(error) = &result {
            let _ = open_failed(&id, error);
        }
        result
    }

    fn apply_ack(&self, app: &mut SlideApp) -> Result<(), String> {
        let message = take_ack().map_err(js_error)?;
        if message.is_null() || message.is_undefined() {
            return Ok(());
        }
        let id = text(&message, "saveId")?;
        let status = text(&message, "status")?;
        let pending = {
            let mut state = self.state.try_borrow_mut().map_err(|_| "host state is busy")?;
            if state.pending.as_ref().is_none_or(|pending| pending.id != id) {
                return Ok(());
            }
            if status == "saved" { state.pending.take() } else { None }
        };
        if let Some(pending) = pending {
            if let Some(apply) = pending.apply {
                apply(&mut app.session);
            }
            let still_dirty = app.session.documents().iter().any(DocState::is_dirty);
            confirm_saved(&id, still_dirty).map_err(js_error)?;
            app.host_status(if still_dirty { "Saved snapshot; newer changes remain unsaved" } else { "Saved by host" }.into());
        } else {
            app.host_status(format!("Host {status}: {}. Serialized bytes are retained", text(&message, "message")?));
        }
        Ok(())
    }

    pub fn observe(&self, app: &SlideApp) {
        if let Some(document) = app.session.active()
            && let Err(error) = self.note_document(document)
        {
            log::error!("host dirty notification: {error}");
        }
    }
}

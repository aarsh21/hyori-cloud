use wasm_bindgen::{JsValue, JsCast as _};
use wasm_bindgen::closure::Closure;

#[wasm_bindgen::prelude::wasm_bindgen(module = "/hyori-native-host.js")]
extern "C" {
    #[wasm_bindgen(js_name = hostRequested)]
    fn js_requested() -> bool;
    #[wasm_bindgen(catch, js_name = prepareHost)]
    fn js_prepare(app: &str, version: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = attachHostRepaint)]
    fn js_attach_repaint(callback: &js_sys::Function) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostReady)]
    fn js_ready() -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostFailed)]
    fn js_failed(message: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostDetached)]
    fn js_detached(message: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostCanExport)]
    fn js_can_export(name: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostHasPendingSave)]
    fn js_has_pending_save() -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostHasRecoverySnapshot)]
    fn js_has_recovery_snapshot() -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostSystemDark)]
    fn js_system_dark() -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeOpen)]
    fn js_take_open() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostOpened)]
    fn js_opened(open_id: &str, document_id: &str, revision: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostOpenFailed)]
    fn js_open_failed(open_id: &str, message: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostObserved)]
    fn js_observed(document_id: &str, revision: &str, dirty: bool) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostSaveRequested)]
    fn js_save_requested(document_id: &str, save_as: bool, name: &JsValue, intent_id: &str) -> Result<bool, JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeSaveRequest)]
    fn js_take_save_request() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostSerialized)]
    fn js_serialized(request_id: &str, document_id: &str, revision: &str, name: &str, bytes: &[u8], save_as: bool) -> Result<String, JsValue>;
    #[wasm_bindgen(catch, js_name = hostSerializationFailed)]
    fn js_serialization_failed(request_id: &str, code: &str, message: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeCancellation)]
    fn js_take_cancellation() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeFailure)]
    fn js_take_failure() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeAcknowledgement)]
    fn js_take_ack() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostAcknowledged)]
    fn js_acknowledged(before_document: &JsValue, before_revision: &str, current_document: &JsValue, current_revision: &str, dirty: bool) -> Result<(), JsValue>;
    #[wasm_bindgen(catch, js_name = hostTakeThemeRequest)]
    fn js_take_theme() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = hostThemeApplied)]
    fn js_theme_applied(request_id: &str, theme: &str, resolved: &str) -> Result<(), JsValue>;
}

fn js_failure(value: JsValue) -> NativeHostFailure {
    NativeHostFailure::SerializationFailed(value.as_string().unwrap_or_else(|| format!("{value:?}")))
}

fn field(value: &JsValue, name: &str) -> Result<JsValue, NativeHostFailure> {
    js_sys::Reflect::get(value, &JsValue::from_str(name)).map_err(js_failure)
}

fn text(value: &JsValue, name: &str) -> Result<String, NativeHostFailure> {
    field(value, name)?.as_string().ok_or_else(|| NativeHostFailure::SerializationFailed(format!("Missing native binding field {name}")))
}

fn optional_text(value: &JsValue, name: &str) -> Result<Option<String>, NativeHostFailure> {
    let value = field(value, name)?;
    if value.is_null() || value.is_undefined() { return Ok(None) }
    value.as_string().map(Some).ok_or_else(|| NativeHostFailure::SerializationFailed(format!("Invalid native binding field {name}")))
}

fn boolean(value: &JsValue, name: &str) -> Result<bool, NativeHostFailure> {
    field(value, name)?.as_bool().ok_or_else(|| NativeHostFailure::SerializationFailed(format!("Invalid native binding field {name}")))
}

fn native_number(value: &JsValue, name: &str) -> Result<u64, NativeHostFailure> {
    text(value, name)?.parse().map_err(|_| NativeHostFailure::SerializationFailed(format!("Invalid native u64 field {name}")))
}

fn absent(value: &JsValue) -> bool { value.is_null() || value.is_undefined() }

fn document_value(identity: Option<NativeHostIdentity>) -> JsValue {
    identity.map(|identity| JsValue::from_str(&identity.document_id.to_string())).unwrap_or(JsValue::NULL)
}

use crate::native_host::{NativeHostAdapter, NativeHostFailure, NativeHostIdentity, NativeHostSnapshot, NativeHostSaveReason, NativeHostIntentFn};
use deckcraft_ui_egui::SlideApp;

impl NativeHostAdapter for SlideApp {
    fn host_identity(&self) -> Option<NativeHostIdentity> { self.native_host_identity() }
    fn host_pending_input(&self) -> bool { self.native_host_pending_input() }
    fn host_install_intents(&mut self, sink: NativeHostIntentFn) { self.native_host_install_intents(sink); }
    fn host_open(&mut self, name: &str, bytes: &[u8]) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        self.native_host_open(name, bytes).map(Some)
    }
    fn host_poll_open(&mut self) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        Err(NativeHostFailure::IdentityChanged)
    }
    fn host_capture(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure> {
        self.native_host_capture_intent(document_id, name, reason, intent_id)
    }
    fn host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> Result<bool, NativeHostFailure> {
        Ok(self.native_host_acknowledge(snapshot, save_as))
    }
    fn host_finish_intent(&mut self, id: &str, exact_replacement: bool) { self.native_host_finish_intent(id, exact_replacement); }
    fn host_cancel_intent(&mut self, id: &str) { self.native_host_cancel_intent(id); }
    fn host_theme(&mut self, _preference: &str, resolved_dark: bool) -> Result<(), NativeHostFailure> {
        self.native_host_theme(resolved_dark)
    }
}

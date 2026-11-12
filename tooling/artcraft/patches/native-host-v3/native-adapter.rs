/// Per-engine adapter implemented in the web crate. Shared frame code owns IPC and the clock.
pub trait NativeHostAdapter {
    fn host_identity(&self) -> Option<NativeHostIdentity>;
    fn host_pending_input(&self) -> bool;
    fn host_install_intents(&mut self, sink: NativeHostIntentFn);

    /// None means a correlated interactive open is pending, not parsed readiness.
    fn host_open(&mut self, name: &str, bytes: &[u8]) -> Result<Option<NativeHostIdentity>, NativeHostFailure>;
    fn host_poll_open(&mut self) -> Result<Option<NativeHostIdentity>, NativeHostFailure>;

    fn host_capture(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure>;
    fn host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> Result<bool, NativeHostFailure>;

    /// Called only after saved/currentRevision was posted. False must drop, never defer, the job.
    fn host_finish_intent(&mut self, intent_id: &str, exact_replacement: bool);
    fn host_cancel_intent(&mut self, intent_id: &str);

    /// System remains an actual native preference where supported; Deck resolves it to dark/light.
    fn host_theme(&mut self, preference: &str, resolved_dark: bool) -> Result<(), NativeHostFailure>;
}

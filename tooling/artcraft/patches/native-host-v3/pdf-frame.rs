use crate::native_host::{NativeHostAdapter, NativeHostFailure, NativeHostFrame, NativeHostIdentity, NativeHostIntentFn, NativeHostSaveReason, NativeHostSnapshot};
use eframe::egui;
use pdfcraft_ui_egui::PdfCraftApp;

impl NativeHostAdapter for PdfCraftApp {
    fn host_identity(&self) -> Option<NativeHostIdentity> { self.native_host_identity() }
    fn host_pending_input(&self) -> bool { self.native_host_pending_input() }
    fn host_install_intents(&mut self, sink: NativeHostIntentFn) { self.native_host_install_intents(sink); }
    fn host_open(&mut self, name: &str, bytes: &[u8]) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        self.native_host_open(name, bytes)
    }
    fn host_poll_open(&mut self) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        self.native_host_poll_open()
    }
    fn host_capture(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure> {
        self.native_host_capture_job(document_id, name, reason, intent_id)
    }
    fn host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> Result<bool, NativeHostFailure> {
        self.native_host_acknowledge(snapshot, save_as)
    }
    fn host_finish_intent(&mut self, intent_id: &str, exact_replacement: bool) {
        self.native_host_finish_intent(intent_id, exact_replacement);
    }
    fn host_cancel_intent(&mut self, intent_id: &str) { self.native_host_cancel_intent(intent_id); }
    fn host_theme(&mut self, preference: &str, _resolved_dark: bool) -> Result<(), NativeHostFailure> {
        self.native_host_theme(preference)
    }
}

pub(crate) struct NativeWebApp {
    app: PdfCraftApp,
    native_host: Option<NativeHostFrame>,
}

impl NativeWebApp {
    pub(crate) fn new(mut app: PdfCraftApp, ctx: &egui::Context) -> Result<Self, NativeHostFailure> {
        let native_host = NativeHostFrame::new(ctx, &mut app)?;
        Ok(Self { app, native_host })
    }
}

pub(crate) fn report_failure(error: NativeHostFailure) {
    eframe::web_sys::console::error_1(&format!("native host: {error}").into());
    let _ = NativeHostFrame::failed(&error.to_string());
}

impl eframe::App for NativeWebApp {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.note_input(&self.app, raw) { report_failure(error); }
        eframe::App::raw_input_hook(&mut self.app, ctx, raw);
    }
    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.before_logic(&mut self.app, ctx) { report_failure(error); }
        eframe::App::logic(&mut self.app, ctx, frame);
        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.after_logic(&mut self.app, ctx) { report_failure(error); }
    }
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        eframe::App::ui(&mut self.app, ui, frame);
        if let Some(host) = self.native_host.as_mut()
            && let Err(error) = host.after_ui(&mut self.app, ui.ctx()) { report_failure(error); }
    }
    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        eframe::App::save(&mut self.app, storage);
    }
}

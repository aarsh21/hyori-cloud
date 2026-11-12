use super::*;

type NativeHostApp = crate::SlideApp;

impl SlideApp {
    /// Native committed presentation revision; no pointer address or dirty-transition heuristic.
    pub fn native_host_identity(&self) -> Option<NativeHostIdentity> {
        self.session.active().map(|document| NativeHostIdentity {
            document_id: document.uid,
            revision: document.revision,
            dirty: document.is_dirty() || self.native_host_pending_input(),
        })
    }

    /// Keep native IME composition and active dialogs out of background serialization.
    pub fn native_host_pending_input(&self) -> bool {
        self.session.active().is_some_and(|document| document.composition.is_some())
            || self.dialog.as_ref().is_some_and(|dialog| dialog.id != "close")
    }

    /// Parse actual native presentation bytes before reporting opened to the host.
    pub fn native_host_open(&mut self, name: &str, bytes: &[u8]) -> Result<NativeHostIdentity, NativeHostFailure> {
        let presentation = deckcraft_engine::cmd::file::open_host_presentation(name, bytes)
            .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        deckcraft_engine::cmd::file::add_opened(&mut self.session, name, Some(name.to_owned()), presentation);
        self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)
    }

    /// Direct existing native serializer; an imported PPTX never silently turns into a copy.
    pub fn native_host_serialize(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure> {
        self.native_host_serialize_options(document_id, name, reason, &json!({}))
    }

    pub(crate) fn native_host_serialize_options(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, options: &Value) -> Result<NativeHostSnapshot, NativeHostFailure> {
        if self.session.active().map(|document| document.uid) != Some(document_id) { return Err(NativeHostFailure::IdentityChanged) }
        if self.dialog.is_some() || (reason == NativeHostSaveReason::Automatic && self.native_host_pending_input()) {
            return Err(NativeHostFailure::Busy("Finish the native composition or dialog before automatic saving".into()));
        }
        if reason == NativeHostSaveReason::Manual {
            self.session.settle_composition();
        }
        let document = self.session.active().ok_or(NativeHostFailure::IdentityChanged)?;
        let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(), "deckcraft" | "pptx" | "potx" | "ppsx" | "outline" | "txt" | "rtf" | "pdf" | "gif") {
            return Err(NativeHostFailure::SerializationFailed("Unsupported native presentation output format".into()));
        }
        let bytes = match extension.as_str() {
            "pdf" => deckcraft_engine::cmd::file::pdf_bytes(&document.doc, options),
            "gif" => deckcraft_engine::cmd::file::gif_bytes(&document.doc, options),
            _ => deckcraft_engine::cmd::file::save_bytes(&document.doc, &extension),
        }.map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        let presentation = document.doc.clone();
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)?;
        Ok(NativeHostSnapshot { identity, name: name.to_owned(), bytes,
            guard: Box::new(move |app| app.session.active().is_some_and(|document| std::sync::Arc::ptr_eq(&document.doc, &presentation))),
        })
    }

    /// A durable copy never retargets the original; replacement only cleans the captured revision.
    pub fn native_host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> bool {
        if save_as || self.native_host_pending_input() || !self.native_host_identity().is_some_and(|current| current.same_snapshot(snapshot.identity)) || !(snapshot.guard)(self) {
            return false;
        }
        let Some(document) = self.session.active() else { return false };
        let saved = document.doc.clone();
        self.session.mark_host_saved(snapshot.identity.document_id, saved)
    }

    /// The bridge resolves System without touching slide themes, typography or document styles.
    pub fn native_host_theme(&mut self, dark: bool) -> Result<(), NativeHostFailure> {
        self.run("view.dark", json!({"on": dark}))
            .map_err(NativeHostFailure::SerializationFailed)?;
        Ok(())
    }
}

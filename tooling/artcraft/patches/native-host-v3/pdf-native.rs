use super::*;

type NativeHostApp = crate::PdfCraftApp;

impl PdfCraftApp {
    /// A default for future annotations, never a rewrite of the document's stored authors.
    pub fn native_host_annotation_author(&mut self, display_name: &str) {
        self.comment_prefs.author = display_name.to_owned();
    }

    /// Native working-file generation, not the number of saved PDF incremental revisions.
    pub fn native_host_identity(&self) -> Option<NativeHostIdentity> {
        let index = self.active?;
        let view = self.views.get(index)?;
        let document = self.session.get(view.id)?;
        Some(NativeHostIdentity {
            document_id: document.id.0,
            revision: document.edit_generation(),
            dirty: self.has_unsaved_work(index),
        })
    }

    /// Conservatively keep a live native field/content editor out of background serialization.
    pub fn native_host_pending_input(&self) -> bool {
        // Print only configures output; opening it must not manufacture a document edit.
        if (self.dialog.is_some() && !matches!(self.dialog, Some(crate::Dialog::Print)))
            || self.password_prompt.is_some() { return true; }
        let Some(view) = self.active.and_then(|index| self.views.get(index)) else { return false };
        view.pending_edit.is_some()
            || view.content.draft.is_some()
            || view.content.blocked().is_some()
            || view.forms.focus.is_some()
            || view.fill_text.is_some()
            || view.line_editor.is_some()
    }

    /// Interactive parser completion is correlated to this prompt's actual source allocation.
    pub fn native_host_open(&mut self, name: &str, bytes: &[u8]) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        if self.native_host_open_pending.is_some() || self.native_host_pending_input() {
            return Err(NativeHostFailure::Busy("Finish the current native input before opening a PDF".into()));
        }
        let previous = self.native_host_identity().map(|identity| identity.document_id);
        self.open_bytes(name, None, bytes.to_vec()).map_err(NativeHostFailure::SerializationFailed)?;
        if let Some(prompt) = self.password_prompt.as_ref() {
            if prompt.name != name || prompt.bytes.as_slice() != bytes {
                return Err(NativeHostFailure::IdentityChanged);
            }
            self.native_host_open_pending = Some(NativeHostPendingOpen { source: prompt.bytes.clone(), result: None });
            return Ok(None);
        }
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)?;
        if previous == Some(identity.document_id) { return Err(NativeHostFailure::IdentityChanged); }
        Ok(Some(identity))
    }

    /// Direct native save pipeline; never invoke intercepted Save or mark_saved before durability.
    pub fn native_host_serialize(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure> {
        let index = self.active.ok_or(NativeHostFailure::IdentityChanged)?;
        let id = self.views.get(index).ok_or(NativeHostFailure::IdentityChanged)?.id;
        if id.0 != document_id { return Err(NativeHostFailure::IdentityChanged) }
        if self.dialog.is_some() || self.password_prompt.is_some() || (reason == NativeHostSaveReason::Automatic && self.native_host_pending_input()) {
            return Err(NativeHostFailure::Busy("Finish the native PDF field, content edit or dialog before automatic saving".into()));
        }
        if !self.commit_typing_in(id) || !self.flatten_fill_sign_for_save(id) {
            return Err(NativeHostFailure::Busy("Native PDF editing needs attention before saving".into()));
        }
        let bytes = self.session.save_bytes(id)
            .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        self.session.check_save(id, &bytes)
            .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)?;
        if identity.document_id != document_id { return Err(NativeHostFailure::IdentityChanged) }
        let working = self.session.get(id).ok_or(NativeHostFailure::IdentityChanged)?.bytes.clone();
        Ok(NativeHostSnapshot { identity, name: name.to_owned(), bytes: bytes.as_ref().clone(),
            guard: Box::new(move |app| app.session.get(id).is_some_and(|document| document.edit_generation() == identity.revision && std::sync::Arc::ptr_eq(&document.bytes, &working))),
        })
    }

    /// mark_saved replaces the current COS graph: exact PRE-apply generation is mandatory.
    /// Its legitimate POST-apply generation bump must be reported as currentRevision by the host.
    pub fn native_host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> Result<bool, NativeHostFailure> {
        if save_as || self.native_host_pending_input() || !self.native_host_identity().is_some_and(|current| current.same_snapshot(snapshot.identity)) || !(snapshot.guard)(self) {
            return Ok(false);
        }
        let index = self.active.ok_or(NativeHostFailure::IdentityChanged)?;
        let id = self.views.get(index).ok_or(NativeHostFailure::IdentityChanged)?.id;
        self.session.mark_saved(id, std::sync::Arc::new(snapshot.bytes.clone()), None)
            .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        if let Some(document) = self.session.get(id) && let Some(view) = self.views.get_mut(index) {
            view.document_changed(&document.info);
        }
        Ok(true)
    }

    /// Update actual native chrome, not the PDF page, document fonts or page content.
    pub fn native_host_theme(&mut self, preference: &str) -> Result<(), NativeHostFailure> {
        let preference = match preference {
            "light" => crate::theme::ThemePreference::Light,
            "dark" => crate::theme::ThemePreference::Dark,
            "system" => crate::theme::ThemePreference::System,
            _ => return Err(NativeHostFailure::SerializationFailed("Unknown native theme".into())),
        };
        self.set_theme_preference(preference);
        Ok(())
    }
}

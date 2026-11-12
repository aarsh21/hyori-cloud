use super::*;

type NativeHostApp = crate::WordApp;

impl WordApp {
    /// Committed native model identity; uncommitted native input is guarded separately.
    pub fn native_host_identity(&self) -> NativeHostIdentity {
        NativeHostIdentity {
            document_id: self.session.document_id(),
            revision: self.session.rev(),
            dirty: self.session.dirty || panes::has_comment_drafts(self) || !self.canvas.ime_preedit.is_empty(),
        }
    }

    /// Whether a delayed save acknowledgement must leave live native input unsaved.
    pub fn native_host_pending_input(&self) -> bool {
        !self.canvas.ime_preedit.is_empty() || panes::has_comment_drafts(self)
            || self.dialog.as_ref().is_some_and(|dialog| !matches!(dialog, dialogs::Dialog::SaveChanges { .. }))
    }

    /// Parse through the existing native open command; a pending dialog is not a parsed-open ack.
    pub fn native_host_open(&mut self, name: &str, bytes: &[u8]) -> Result<NativeHostIdentity, NativeHostFailure> {
        let previous = self.session.document_id();
        self.run("file.open", json!({"path": name, "data": wordcraft_engine::cmd::insert::base64_encode(bytes)}))
            .map_err(NativeHostFailure::SerializationFailed)?;
        let identity = self.native_host_identity();
        if identity.document_id == previous {
            return Err(NativeHostFailure::Busy("Native opening needs input before the document is parsed".into()));
        }
        self.ui.backstage = false;
        Ok(identity)
    }

    /// Direct native serializer: never re-enter the intercepted File Save command.
    pub fn native_host_serialize(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure> {
        self.native_host_serialize_options(document_id, name, reason, &json!({}), true)
    }

    pub(crate) fn native_host_serialize_options(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, params: &Value, native_save: bool) -> Result<NativeHostSnapshot, NativeHostFailure> {
        if self.session.document_id() != document_id {
            return Err(NativeHostFailure::IdentityChanged);
        }
        if !self.canvas.ime_preedit.is_empty() || self.dialog.is_some() {
            return Err(NativeHostFailure::Busy("Finish the current native composition or dialog before saving".into()));
        }
        if reason == NativeHostSaveReason::Automatic && panes::has_comment_drafts(self) {
            return Err(NativeHostFailure::Busy("The native comment draft is still being edited".into()));
        }
        panes::flush_comment_drafts(self).map_err(NativeHostFailure::Busy)?;
        if native_save {
            if let Some(password) = params.get("password").filter(|value| !value.is_null()) {
                if !wordcraft_engine::io::can_encrypt(name) || password.as_str().is_none_or(str::is_empty) {
                    return Err(NativeHostFailure::SerializationFailed("Only Word documents can be saved with a nonempty password".into()));
                }
                self.session.run("file.encrypt", &json!({"password": password}))
                    .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
            }
            self.session.stamp_save();
        }
        let options = wordcraft_engine::cmd::file::export_options(&self.session, params);
        let password = if native_save { self.session.password.as_ref().map(wordcraft_engine::Password::as_str) } else { None };
        let bytes = wordcraft_engine::io::save_bytes_with(name, &self.session.doc, password, &options)
            .map_err(NativeHostFailure::SerializationFailed)?;
        let identity = self.native_host_identity();
        if identity.document_id != document_id {
            return Err(NativeHostFailure::IdentityChanged);
        }
        let document = self.session.doc.clone();
        Ok(NativeHostSnapshot { identity, name: name.to_owned(), bytes,
            guard: Box::new(move |app| app.session.doc.same_content(&document)),
        })
    }

    /// Clean only an exact durable replacement snapshot; copies do not retarget the source.
    pub fn native_host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> bool {
        if save_as || !self.native_host_identity().same_snapshot(snapshot.identity) || self.native_host_pending_input() || !(snapshot.guard)(self) {
            return false;
        }
        self.session.dirty = false;
        true
    }

    /// Change actual native chrome preference; the frame owner acknowledges after its UI pass.
    pub fn native_host_theme(&mut self, preference: &str) -> Result<(), NativeHostFailure> {
        self.execute("ui.theme", json!({"value": preference}))
            .map_err(NativeHostFailure::SerializationFailed)?;
        Ok(())
    }
}

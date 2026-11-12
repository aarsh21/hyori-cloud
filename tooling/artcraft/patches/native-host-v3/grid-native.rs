use super::*;

type NativeHostApp = crate::SheetApp;

impl SheetApp {
    /// Committed native model identity, plus conservative pending-input dirty state.
    pub fn native_host_identity(&self) -> Option<NativeHostIdentity> {
        self.session.active().map(|document| NativeHostIdentity {
            document_id: document.uid,
            revision: document.revision,
            dirty: document.is_dirty() || self.native_host_pending_input(),
        })
    }

    /// Do not consume a live cell/text-box editor from a background autosave.
    pub fn native_host_pending_input(&self) -> bool {
        self.editor.is_some() || self.text_box_editor.is_some() || self.name_box.is_some()
            || self.synthetic_pending || !self.synthetic.is_empty()
            || self.dialog.as_ref().is_some_and(|dialog| dialog.name != "saveChanges")
    }

    /// A password prompt carries a private native marker; another opened workbook cannot answer it.
    pub fn native_host_open(&mut self, name: &str, bytes: &[u8]) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        if self.native_host_open_pending.is_some() || self.native_host_pending_input() {
            return Err(NativeHostFailure::Busy("Finish the current native input before opening a workbook".into()));
        }
        let previous = self.session.active().map(|document| document.uid);
        let params = json!({"name": name, "base64": gridcraft_engine::io::base64_encode(bytes)});
        match self.run("file.open", params.clone()) {
            Ok(result) => self.after_open(None, &result),
            Err(error) if error.contains(gridcraft_engine::io::PASSWORD_REQUIRED) => {
                self.open_dialog("openPassword", params);
                let dialog = self.dialog.as_mut().filter(|dialog| dialog.name == "openPassword")
                    .ok_or(NativeHostFailure::IdentityChanged)?;
                let marker = std::sync::Arc::new(());
                dialog.native_host_open = Some(marker.clone());
                self.native_host_open_pending = Some(NativeHostPendingOpen { marker, result: None });
                return Ok(None);
            }
            Err(error) => return Err(NativeHostFailure::SerializationFailed(error)),
        }
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)?;
        if previous == Some(identity.document_id) { return Err(NativeHostFailure::IdentityChanged); }
        self.backstage = None;
        Ok(Some(identity))
    }

    /// Direct native serialization; the exact requested name also controls workbook-internal links.
    pub fn native_host_serialize(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure> {
        if self.session.active().map(|document| document.uid) != Some(document_id) {
            return Err(NativeHostFailure::IdentityChanged);
        }
        if self.dialog.as_ref().is_some_and(|dialog| dialog.name != "saveChanges")
            || self.synthetic_pending || !self.synthetic.is_empty()
            || (reason == NativeHostSaveReason::Automatic && self.native_host_pending_input()) {
            return Err(NativeHostFailure::Busy("Finish the active native cell, text-box edit or dialog before automatic saving".into()));
        }
        if reason == NativeHostSaveReason::Manual {
            self.settle_drafts().map_err(NativeHostFailure::Busy)?;
        }
        self.store_view_state();
        let document = self.session.active().ok_or(NativeHostFailure::IdentityChanged)?;
        let bytes = gridcraft_engine::io::save_bytes(&document.wb, name)
            .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
        let workbook = document.wb.clone();
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged)?;
        if identity.document_id != document_id {
            return Err(NativeHostFailure::IdentityChanged);
        }
        Ok(NativeHostSnapshot { identity, name: name.to_owned(), bytes,
            guard: Box::new(move |app| app.session.active().is_some_and(|document| std::sync::Arc::ptr_eq(&document.wb, &workbook))),
        })
    }

    /// A replacement ack updates only the exact current workbook baseline, never another tab.
    pub fn native_host_acknowledge(&mut self, snapshot: &NativeHostSnapshot, save_as: bool) -> bool {
        if save_as || self.native_host_pending_input() || !self.native_host_identity().is_some_and(|current| current.same_snapshot(snapshot.identity)) || !(snapshot.guard)(self) {
            return false;
        }
        let Some(document) = self.session.active_mut() else { return false };
        document.saved = document.wb.clone();
        true
    }

    /// Change the native preference; actual palette application happens in the native UI pass.
    pub fn native_host_theme(&mut self, preference: &str) -> Result<(), NativeHostFailure> {
        self.run("view.theme", json!({"mode": preference}))
            .map_err(NativeHostFailure::SerializationFailed)?;
        Ok(())
    }
}

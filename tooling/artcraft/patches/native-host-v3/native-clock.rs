use super::{egui, NativeHostFailure, NativeHostIdentity};

/// Rust-owned coherent host token. It includes actual native input epochs, model changes and
/// draft/composition lifetime, not a JavaScript frame count or a pointer serialized over IPC.
#[derive(Default)]
pub struct NativeHostClock {
    revision: u64,
    input_epoch: u64,
    observed: Option<(Option<(u64, u64)>, bool, bool, u64)>,
    exhausted: bool,
}

impl NativeHostClock {
    fn active(&self) -> Result<(), NativeHostFailure> {
        if self.exhausted {
            Err(NativeHostFailure::SerializationFailed("Native host revision space is exhausted".into()))
        } else {
            Ok(())
        }
    }

    /// Called ONCE from the real raw_input_hook, before native logic/UI can consume this input.
    /// A queued edit invalidates an older ack even before the UI commits it to the model.
    pub fn note_input(&mut self, raw: &egui::RawInput, pending_input: bool) -> Result<(), NativeHostFailure> {
        self.active()?;
        let edit_input = raw.events.iter().any(|event| matches!(event,
            egui::Event::Text(_) | egui::Event::Paste(_) | egui::Event::Cut
            | egui::Event::Ime(_) | egui::Event::Key { pressed: true, .. }
            | egui::Event::PointerButton { pressed: true, .. }
        ));
        if edit_input || (pending_input && !raw.events.is_empty()) {
            self.invalidate()?;
        }
        Ok(())
    }

    /// An exact native COW/snapshot guard can discover a state change without a model-rev bump.
    /// Keep that state dirty and allocate a fresh token; never reuse an acknowledged token.
    pub fn invalidate(&mut self) -> Result<(), NativeHostFailure> {
        self.active()?;
        match self.input_epoch.checked_add(1) {
            Some(next) => { self.input_epoch = next; Ok(()) }
            None => {
                self.exhausted = true;
                Err(NativeHostFailure::SerializationFailed("Native input revision space is exhausted".into()))
            }
        }
    }

    /// Observe after logic/UI and again after native input settling, before snapshot publication.
    /// Empty repaint passes are stable; appearance/cancellation of a draft changes the token.
    pub fn observe(&mut self, model: Option<NativeHostIdentity>, pending_input: bool, host_dirty: bool) -> Result<u64, NativeHostFailure> {
        self.active()?;
        let identity = model.map(|identity| (identity.document_id, identity.revision));
        let dirty = host_dirty || model.is_some_and(|identity| identity.dirty) || pending_input;
        let signature = (identity, pending_input, dirty, self.input_epoch);
        if self.observed != Some(signature) {
            match self.revision.checked_add(1) {
                Some(next) => self.revision = next,
                None => {
                    self.exhausted = true;
                    return Err(NativeHostFailure::SerializationFailed("Native host revision space is exhausted".into()));
                }
            }
            self.observed = Some(signature);
        }
        Ok(self.revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> Option<NativeHostIdentity> {
        Some(NativeHostIdentity { document_id: 42, revision: 7, dirty: true })
    }

    #[test]
    fn idle_repaints_do_not_allocate_revisions() {
        let mut clock = NativeHostClock::default();
        let first = clock.observe(model(), false, false).unwrap();
        clock.note_input(&egui::RawInput::default(), false).unwrap();
        assert_eq!(clock.observe(model(), false, false).unwrap(), first);
    }

    #[test]
    fn queued_native_typing_invalidates_ack_before_model_revision_changes() {
        let mut clock = NativeHostClock::default();
        let first = clock.observe(model(), false, false).unwrap();
        let raw = egui::RawInput { events: vec![egui::Event::Text("synthetic".into())], ..Default::default() };
        clock.note_input(&raw, false).unwrap();
        assert_ne!(clock.observe(model(), false, false).unwrap(), first);
    }

    #[test]
    fn draft_edit_cancel_and_ime_cancel_have_distinct_coherent_tokens() {
        let mut clock = NativeHostClock::default();
        let first = clock.observe(model(), false, false).unwrap();
        let draft = clock.observe(model(), true, false).unwrap();
        assert_ne!(draft, first);
        let raw = egui::RawInput { events: vec![egui::Event::PointerMoved(egui::pos2(5.0, 5.0))], ..Default::default() };
        clock.note_input(&raw, true).unwrap();
        let edited = clock.observe(model(), true, false).unwrap();
        assert_ne!(edited, draft);
        let cancelled = clock.observe(model(), false, false).unwrap();
        assert_ne!(cancelled, edited);
        let ime = egui::RawInput { events: vec![egui::Event::Ime(egui::ImeEvent::Preedit { text: String::new(), active_range_chars: None })], ..Default::default() };
        clock.note_input(&ime, false).unwrap();
        assert_ne!(clock.observe(model(), false, false).unwrap(), cancelled);
    }

    #[test]
    fn closed_or_replaced_native_document_cannot_reuse_old_token() {
        let mut clock = NativeHostClock::default();
        let first = clock.observe(model(), false, false).unwrap();
        let closed = clock.observe(None, false, false).unwrap();
        assert_ne!(closed, first);
        assert_ne!(clock.observe(Some(NativeHostIdentity { document_id: 43, revision: 7, dirty: true }), false, false).unwrap(), closed);
    }

    #[test]
    fn exhaustion_fails_closed_instead_of_wrapping() {
        let mut clock = NativeHostClock { revision: u64::MAX, ..Default::default() };
        assert!(clock.observe(model(), false, false).is_err());
        assert!(clock.observe(None, false, false).is_err());
    }
}

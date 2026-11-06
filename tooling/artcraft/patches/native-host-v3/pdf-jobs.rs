pub(crate) struct NativeHostPendingOpen {
    pub source: std::sync::Arc<Vec<u8>>,
    pub result: Option<Result<NativeHostIdentity, NativeHostFailure>>,
}

impl PdfCraftApp {
    pub fn native_host_install_intents(&mut self, sink: NativeHostIntentFn) {
        self.host_save = None;
        self.host_dirty = None;
        self.native_host_intents = Some(sink);
    }

    pub(crate) fn native_host_save_then(&mut self, index: usize, target: SaveTarget, after: NativeHostContinuation) -> bool {
        let result = (|| {
            if self.native_host_job.is_some() {
                return Err(NativeHostFailure::Busy("A native save is already awaiting its result".into()));
            }
            let id = self.views.get(index).ok_or(NativeHostFailure::IdentityChanged)?.id;
            if !self.native_host_identity().is_some_and(|identity| identity.document_id == id.0) {
                return Err(NativeHostFailure::Busy("Select the PDF being saved before requesting cloud persistence".into()));
            }
            let document = self.session.get(id).ok_or(NativeHostFailure::IdentityChanged)?;
            let name = if document.name.to_ascii_lowercase().ends_with(".pdf") {
                format!("{}.pdf", &document.name[..document.name.len() - 4])
            } else { format!("{}.pdf", document.name) };
            let save_as = target == SaveTarget::As;
            let sink = self.native_host_intents.as_ref().ok_or(NativeHostFailure::IdentityChanged)?;
            let delegated = sink(NativeHostIntent { document_id: id.0, save_as, name: save_as.then(|| name.clone()) })?;
            let Some(intent_id) = delegated else {
                if !save_as {
                    return Err(NativeHostFailure::SerializationFailed("Cloud replacement cannot fall back to a local download".into()));
                }
                #[cfg(target_arch = "wasm32")]
                {
                    let snapshot = self.native_host_serialize(id.0, &name, NativeHostSaveReason::Manual)?;
                    crate::editing::download(&snapshot.name, &snapshot.bytes).map_err(NativeHostFailure::SerializationFailed)?;
                    // A local copy neither changes the original baseline nor runs SaveChanges.
                    return Ok(());
                }
                #[cfg(not(target_arch = "wasm32"))]
                return Err(NativeHostFailure::SerializationFailed("Browser local export is unavailable".into()));
            };
            self.native_host_job = Some(NativeHostJob {
                intent_id,
                document_id: id.0,
                serializer: Some(Box::new(|app, document_id, name, reason| {
                    if !name.ends_with(".pdf") {
                        return Err(NativeHostFailure::SerializationFailed("A native PDF save must keep its selected PDF format".into()));
                    }
                    app.native_host_serialize(document_id, name, reason)
                })),
                continuation: Some(after),
            });
            Ok(())
        })();
        if let Err(error) = result { self.notify(error.to_string()); }
        // Emitting intent is not a completed write. The frame owns the later durable result.
        false
    }

    pub fn native_host_capture_job(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure> {
        let Some(intent_id) = intent_id else { return self.native_host_serialize(document_id, name, reason) };
        if !self.native_host_job.as_ref().is_some_and(|job| job.intent_id == intent_id && job.document_id == document_id) {
            return Err(NativeHostFailure::IdentityChanged);
        }
        let job = self.native_host_job.take().ok_or(NativeHostFailure::IdentityChanged)?;
        let result = match job.serializer.as_ref() {
            Some(serialize) => serialize(self, document_id, name, reason),
            None => self.native_host_serialize(document_id, name, reason),
        };
        self.native_host_job = Some(job);
        result
    }

    pub fn native_host_cancel_intent(&mut self, intent_id: &str) {
        if self.native_host_job.as_ref().is_some_and(|job| job.intent_id == intent_id) {
            self.native_host_job = None;
        }
    }

    pub fn native_host_finish_intent(&mut self, intent_id: &str, exact_replacement: bool) {
        if !self.native_host_job.as_ref().is_some_and(|job| job.intent_id == intent_id) { return; }
        let Some(job) = self.native_host_job.take() else { return };
        if exact_replacement && !self.native_host_pending_input()
            && self.native_host_identity().is_some_and(|identity| identity.document_id == job.document_id)
            && let Some(after) = job.continuation {
            after(self);
        }
    }

    pub(crate) fn native_host_password_opened(&mut self, source: &std::sync::Arc<Vec<u8>>) {
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged);
        if let Some(pending) = self.native_host_open_pending.as_mut()
            && std::sync::Arc::ptr_eq(source, &pending.source) {
            pending.result = Some(identity);
        }
    }

    pub(crate) fn native_host_cancel_open(&mut self, source: &std::sync::Arc<Vec<u8>>) {
        if let Some(pending) = self.native_host_open_pending.as_mut()
            && std::sync::Arc::ptr_eq(source, &pending.source) {
            pending.result = Some(Err(NativeHostFailure::SerializationFailed("The requested native PDF open was cancelled".into())));
        }
    }

    pub fn native_host_poll_open(&mut self) -> Result<Option<NativeHostIdentity>, NativeHostFailure> {
        let Some(pending) = self.native_host_open_pending.as_mut() else { return Ok(None) };
        if let Some(result) = pending.result.take() {
            self.native_host_open_pending = None;
            let opened = result?;
            return self.native_host_identity().filter(|current| current.document_id == opened.document_id)
                .map(Some).ok_or(NativeHostFailure::IdentityChanged);
        }
        let waiting = self.password_prompt.as_ref().is_some_and(|prompt| std::sync::Arc::ptr_eq(&prompt.bytes, &pending.source));
        if !waiting {
            self.native_host_open_pending = None;
            return Err(NativeHostFailure::SerializationFailed("The requested native PDF open failed or was replaced".into()));
        }
        Ok(None)
    }
}

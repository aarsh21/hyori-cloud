pub(crate) struct NativeHostPendingOpen {
    pub marker: std::sync::Arc<()>,
    pub result: Option<Result<NativeHostIdentity, NativeHostFailure>>,
}

impl SheetApp {
    pub fn native_host_install_intents(&mut self, sink: NativeHostIntentFn) {
        self.native_host_intents = Some(sink);
    }

    fn native_host_queue(
        &mut self,
        document_id: u64,
        name: Option<String>,
        save_as: bool,
        continuation: Option<NativeHostContinuation>,
    ) -> Result<bool, NativeHostFailure> {
        if self.native_host_job.is_some() {
            return Err(NativeHostFailure::Busy("A native save is already awaiting its result".into()));
        }
        let sink = self.native_host_intents.as_ref().ok_or(NativeHostFailure::IdentityChanged)?;
        let extension = name.as_deref().and_then(|name| std::path::Path::new(name).extension())
            .and_then(|extension| extension.to_str()).map(str::to_owned);
        let Some(intent_id) = sink(NativeHostIntent { document_id, save_as, name })? else {
            if save_as { return Ok(false); }
            return Err(NativeHostFailure::SerializationFailed("Cloud replacement cannot fall back to a local download".into()));
        };
        self.native_host_job = Some(NativeHostJob {
            intent_id,
            document_id,
            serializer: Some(Box::new(move |app, document_id, destination, reason| {
                let selected = std::path::Path::new(destination).extension().and_then(|extension| extension.to_str());
                if extension.as_deref().is_some_and(|expected| selected != Some(expected)) {
                    return Err(NativeHostFailure::SerializationFailed("The selected native output format cannot change during destination selection".into()));
                }
                app.native_host_serialize(document_id, destination, reason)
            })),
            continuation,
        });
        Ok(true)
    }

    pub(crate) fn native_host_command(&mut self, command: &str, params: &Json) -> Option<Result<Json, String>> {
        if self.native_host_intents.is_none() || !matches!(command, "file.save" | "file.saveAs") {
            return None;
        }
        let result = (|| {
            let document = self.session.active().ok_or(NativeHostFailure::IdentityChanged)?;
            let document_id = document.uid;
            let chosen = params.get("path").and_then(Json::as_str).filter(|name| !name.is_empty());
            let save_as = command == "file.saveAs" || chosen.is_some();
            let name = chosen.map(str::to_owned).or_else(|| save_as.then(|| {
                let title = document.display_title();
                let stem = std::path::Path::new(&title).file_stem().and_then(|stem| stem.to_str()).unwrap_or("Book");
                format!("{stem}.xlsx")
            }));
            if self.native_host_queue(document_id, name.clone(), save_as, None)? {
                return Ok(json!({"pending": true}));
            }
            // Only an explicitly unsupported local copy reaches this path. Keep the native
            // chosen filename/format, but never run file.save's path/baseline mutation.
            let name = name.ok_or(NativeHostFailure::IdentityChanged)?;
            if std::path::Path::new(&name).extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")) {
                self.settle_drafts().map_err(NativeHostFailure::Busy)?;
                self.store_view_state();
                // Native Save As PDF is the print pipeline, not workbook serialization. Preserve
                // every chosen print option; only replace the disk destination with local download.
                let mut options = params.clone();
                options.as_object_mut().ok_or(NativeHostFailure::IdentityChanged)?.remove("path");
                let result = self.session.run("file.exportPdf", options)
                    .map_err(|error| NativeHostFailure::SerializationFailed(error.to_string()))?;
                let bytes = result.get("base64").and_then(Json::as_str).and_then(gridcraft_engine::io::base64_decode)
                    .ok_or_else(|| NativeHostFailure::SerializationFailed("Native PDF export returned no bytes".into()))?;
                let download = self.services.download.as_ref().ok_or_else(|| NativeHostFailure::SerializationFailed("Local PDF export is unavailable".into()))?;
                download(&name, &bytes);
                return Ok(json!({"name": name, "bytes": bytes.len(), "localExport": true}));
            }
            let snapshot = self.native_host_serialize(document_id, &name, NativeHostSaveReason::Manual)?;
            let download = self.services.download.as_ref().ok_or_else(|| NativeHostFailure::SerializationFailed("Local export is unavailable".into()))?;
            download(&snapshot.name, &snapshot.bytes);
            Ok(json!({"name": snapshot.name, "bytes": snapshot.bytes.len(), "localExport": true}))
        })();
        Some(result.map_err(|error: NativeHostFailure| error.to_string()))
    }

    pub(crate) fn native_host_save_changes(&mut self, answer: crate::SaveAnswer, quitting: bool, ctx: &egui::Context) -> Option<bool> {
        if self.native_host_intents.is_none() || !matches!(answer, crate::SaveAnswer::Save) {
            return None;
        }
        let Some(document_id) = self.native_host_identity().map(|identity| identity.document_id) else { return Some(false) };
        let ctx = ctx.clone();
        let after: NativeHostContinuation = Box::new(move |app| {
            if app.session.active().is_some_and(|document| document.uid == document_id) {
                app.run_or_alert("file.close", json!({"force": true, "document": true}));
                if quitting { app.continue_quit(&ctx); }
            }
        });
        match self.native_host_queue(document_id, None, false, Some(after)) {
            Ok(true) => Some(true),
            Ok(false) => Some(false),
            Err(error) => { self.alert(error.to_string()); Some(false) }
        }
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

    pub(crate) fn native_host_password_opened(&mut self, marker: Option<&std::sync::Arc<()>>) {
        let identity = self.native_host_identity().ok_or(NativeHostFailure::IdentityChanged);
        if let Some(pending) = self.native_host_open_pending.as_mut()
            && marker.is_some_and(|marker| std::sync::Arc::ptr_eq(marker, &pending.marker)) {
            pending.result = Some(identity);
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
        let waiting = self.dialog.as_ref().and_then(|dialog| dialog.native_host_open.as_ref())
            .is_some_and(|marker| std::sync::Arc::ptr_eq(marker, &pending.marker));
        if !waiting {
            self.native_host_open_pending = None;
            return Err(NativeHostFailure::SerializationFailed("The requested native workbook open was cancelled or replaced".into()));
        }
        Ok(None)
    }
}

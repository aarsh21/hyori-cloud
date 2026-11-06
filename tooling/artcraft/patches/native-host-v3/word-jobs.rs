impl WordApp {
    pub fn native_host_install_intents(&mut self, sink: NativeHostIntentFn) {
        self.services.host_save = None;
        self.native_host_intents = Some(sink);
    }

    pub(crate) fn native_host_begin_intent(&mut self, save_as: bool, name: Option<String>, serializer: Option<NativeHostSerializer>, continuation: Option<NativeHostContinuation>) -> Result<bool, NativeHostFailure> {
        let Some(sink) = self.native_host_intents.as_ref() else { return Ok(false) };
        if self.native_host_job.is_some() {
            return Err(NativeHostFailure::Busy("A native save intent is already pending".into()));
        }
        let document_id = self.session.document_id();
        let Some(intent_id) = sink(NativeHostIntent { document_id, save_as, name })? else { return Ok(false) };
        self.native_host_job = Some(NativeHostJob { intent_id, document_id, serializer, continuation });
        Ok(true)
    }

    pub fn native_host_capture_intent(&mut self, document_id: u64, name: &str, reason: NativeHostSaveReason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure> {
        let Some(id) = intent_id else { return self.native_host_serialize(document_id, name, reason) };
        if !self.native_host_job.as_ref().is_some_and(|job| job.intent_id == id && job.document_id == document_id) {
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

    pub fn native_host_cancel_intent(&mut self, id: &str) {
        if self.native_host_job.as_ref().is_some_and(|job| job.intent_id == id) {
            self.native_host_job = None;
        }
    }

    pub fn native_host_finish_intent(&mut self, id: &str, exact_replacement: bool) {
        if !self.native_host_job.as_ref().is_some_and(|job| job.intent_id == id) { return }
        let Some(job) = self.native_host_job.take() else { return };
        if exact_replacement && self.session.document_id() == job.document_id
            && let Some(continuation) = job.continuation
        { continuation(self); }
    }
}

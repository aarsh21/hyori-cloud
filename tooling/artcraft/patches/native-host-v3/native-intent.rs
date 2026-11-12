/// Native UI intent metadata. Its ID is allocated by the frame sink, never by the parent.
pub struct NativeHostIntent {
    pub document_id: u64,
    pub save_as: bool,
    pub name: Option<String>,
}

/// Some(id) delegates to cloud; None preserves an explicitly chosen unsupported local export.
/// Replacement never falls through to a local download. Busy must not replace an existing job.
pub type NativeHostIntentFn = Box<dyn Fn(NativeHostIntent) -> Result<Option<String>, NativeHostFailure>>;

/// A native export closure retains the exact chosen options, but accepts a renamed destination.
/// This is a private native job, not a second IPC contract or an intercepted command callback.
pub type NativeHostSerializer = Box<dyn Fn(&mut NativeHostApp, u64, &str, NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure>>;

/// A held New/Open/Close action can run only after an exact, uncancelled durable replacement.
pub type NativeHostContinuation = Box<dyn FnOnce(&mut NativeHostApp)>;

/// The app owns chosen export options and any continuation; the frame owns captured save bytes.
/// Cancellation drops this job, never the independent immutable snapshot or source dirty state.
pub struct NativeHostJob {
    pub intent_id: String,
    pub document_id: u64,
    pub serializer: Option<NativeHostSerializer>,
    pub continuation: Option<NativeHostContinuation>,
}

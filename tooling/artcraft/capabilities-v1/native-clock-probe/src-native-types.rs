/// Why the host requested native capture; only explicit manual actions may settle live editors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeHostSaveReason {
    /// An explicit user Save/SaveCopy action.
    Manual,
    /// Background capture must preserve a live editor or report busy.
    Automatic,
}

/// Native model identity, never a backend file revision or JavaScript number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeHostIdentity {
    pub document_id: u64,
    pub revision: u64,
    pub dirty: bool,
}

/// Bytes produced by the engine, captured with the identity after native input settling.
pub struct NativeHostSnapshot {
    pub identity: NativeHostIdentity,
    pub name: String,
    pub bytes: Vec<u8>,
    // Additional native snapshot witness. Never serialized as an IPC revision or pointer value.
    guard: Box<dyn Fn(&NativeHostApp) -> bool>,
}

#[derive(Debug)]
pub enum NativeHostFailure {
    Busy(String),
    IdentityChanged,
    SerializationFailed(String),
}

impl NativeHostFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy(_) => "busy",
            Self::IdentityChanged => "identity-changed",
            Self::SerializationFailed(_) => "serialization-failed",
        }
    }
}

impl std::fmt::Display for NativeHostFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy(message) | Self::SerializationFailed(message) => formatter.write_str(message),
            Self::IdentityChanged => formatter.write_str("The native document no longer matches the host source"),
        }
    }
}

impl std::error::Error for NativeHostFailure {}

impl NativeHostIdentity {
    /// Dirty is deliberately excluded: only document/revision equality identifies a snapshot.
    pub fn same_snapshot(self, other: Self) -> bool {
        self.document_id == other.document_id && self.revision == other.revision
    }
}

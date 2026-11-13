use crate::Failure;
use serde::{Deserialize, Serialize};

/// Private operator diagnostics. Never copy raw decoder stderr, paths or media metadata here.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Probe,
    Encode,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Rejected,
    InvalidData,
    MissingCodec,
    FilterFailure,
    AllocationFailed,
    OutputLimit,
    Deadline,
    ProcessUnavailable,
    InvalidProbe,
    MissingVisual,
    MissingDuration,
    InputLimit,
    InvalidOutput,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Diagnostic {
    pub stage: Stage,
    pub reason: Reason,
}

impl crate::ErrorBody {
    pub fn diagnostic(error: Failure, stage: Stage, reason: Reason) -> Self {
        Self {
            error,
            diagnostic: Some(Diagnostic { stage, reason }),
        }
    }
}
impl From<Failure> for crate::ErrorBody {
    fn from(error: Failure) -> Self {
        Self {
            error,
            diagnostic: None,
        }
    }
}

/// Match only fixed decoder phrases to an allowlist; unmatched output never leaves the worker.
pub fn rejection_reason(stderr: &[u8]) -> Reason {
    let text = String::from_utf8_lossy(stderr);
    if text.contains("Invalid data found") || text.contains("moov atom not found") {
        Reason::InvalidData
    } else if text.contains("Decoder not found") || text.contains("Unknown decoder") {
        Reason::MissingCodec
    } else if text.contains("Error reinitializing filters")
        || text.contains("Error configuring filter")
    {
        Reason::FilterFailure
    } else if text.contains("Cannot allocate memory") {
        Reason::AllocationFailed
    } else {
        Reason::Rejected
    }
}

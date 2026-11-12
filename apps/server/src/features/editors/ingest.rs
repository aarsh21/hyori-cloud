use crate::error::ApiError;
use futures_util::StreamExt;
use hyori_storage::{StorageError, StorageStream};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Hashes an editor part while the existing multipart transport consumes it, including replay drains.
pub(crate) struct PartDigest(Arc<Mutex<Sha256>>);
impl PartDigest {
    pub fn wrap(body: StorageStream) -> (StorageStream, Self) {
        let hash = Arc::new(Mutex::new(Sha256::new()));
        let writer = hash.clone();
        let body = body.map(move |chunk| {
            let bytes = chunk?;
            writer
                .lock()
                .map_err(|_| StorageError::Body("digest unavailable"))?
                .update(&bytes);
            Ok(bytes)
        });
        (Box::pin(body), Self(hash))
    }
    pub fn finish(self) -> Result<String, ApiError> {
        Ok(hex::encode(
            self.0
                .lock()
                .map_err(|_| ApiError::unavailable())?
                .clone()
                .finalize(),
        ))
    }
}

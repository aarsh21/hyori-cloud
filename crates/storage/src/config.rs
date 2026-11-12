use crate::{Result, StorageError};
use std::fmt;
use url::Url;

/// Explicit server-only configuration. The adapter never reads process credentials or environment.
#[derive(Clone)]
pub struct StorageConfig {
    /// Explicit HTTP(S) S3 origin, without user information, path, query or fragment.
    pub endpoint: String,
    /// Explicit signing region (for RustFS, normally `us-east-1`).
    pub region: String,
    /// Application-owned bucket, a lowercase DNS label.
    pub bucket: String,
    /// Server-only explicit access key; no ambient provider chain is consulted.
    pub access_key_id: String,
    /// Server-only secret, redacted from this type's Debug implementation.
    pub secret_access_key: String,
}

impl fmt::Debug for StorageConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StorageConfig")
            .field("endpoint", &"[server-only]")
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl StorageConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        let endpoint = Url::parse(&self.endpoint)
            .map_err(|_| StorageError::InvalidConfig("endpoint must be an absolute HTTP(S) URL"))?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err(StorageError::InvalidConfig(
                "endpoint must be an HTTP(S) origin without credentials, path, query or fragment",
            ));
        }
        if self.region.is_empty()
            || self.region.len() > 63
            || !self
                .region
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(StorageError::InvalidConfig("invalid explicit region"));
        }
        let bucket = self.bucket.as_bytes();
        if !(3..=63).contains(&bucket.len())
            || !bucket[0].is_ascii_alphanumeric()
            || !bucket[bucket.len() - 1].is_ascii_alphanumeric()
            || !bucket
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        {
            return Err(StorageError::InvalidConfig(
                "bucket must be a 3–63 character lowercase DNS label",
            ));
        }
        for credential in [&self.access_key_id, &self.secret_access_key] {
            if credential.is_empty()
                || credential.len() > 4096
                || credential
                    .bytes()
                    .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            {
                return Err(StorageError::InvalidConfig(
                    "invalid explicit storage credentials",
                ));
            }
        }
        Ok(())
    }
}

pub(crate) fn owner_prefix(owner_id: &str) -> Result<String> {
    if !valid_segment(owner_id) {
        return Err(StorageError::InvalidInput(
            "owner ID must be an opaque ID, not a path",
        ));
    }
    Ok(format!("owners/{owner_id}/"))
}

pub(crate) fn validate_key(key: &str) -> Result<()> {
    let mut segments = key.split('/');
    if key.len() > 1024
        || segments.next() != Some("owners")
        || !segments.next().is_some_and(valid_segment)
    {
        return Err(StorageError::InvalidInput("invalid private object key"));
    }
    let rest: Vec<_> = segments.collect();
    if rest.is_empty() || !rest.iter().all(|segment| valid_segment(segment)) {
        return Err(StorageError::InvalidInput("invalid private object key"));
    }
    Ok(())
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

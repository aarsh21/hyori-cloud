//! Server-only RustFS/S3 capability. Authorization, durable upload state, quota and DB commits
//! belong to the product server, never to this adapter or retried database callbacks.
//!
//! Object keys must be unique, immutable, server-generated `owners/{opaque-owner}/{opaque-key}`
//! paths. In particular, completion replay relies on a unique key and exact expected size; size
//! is not a checksum and must not be used to reconcile writes to a reused key.
//! Clone the client for the application lifetime. Drop an upload future or download stream to
//! cancel local work; remote work may already have happened and requires durable reconciliation.
//!
//! ```no_run
//! use hyori_storage::{ObjectStorage, StorageConfig, StorageStream, PartRef};
//! # async fn example(config: StorageConfig, incoming: StorageStream) -> hyori_storage::Result<()> {
//! let storage = ObjectStorage::new(config)?;
//! storage.ensure_bucket().await?;
//! let key = "owners/opaque_owner/unique_object";
//! // The product commits a durable key intent BEFORE begin (including ambiguous begins).
//! let id = storage.begin(key, "application/octet-stream").await?;
//! // Persist `id` before accepting parts. Reconstructing the client does not lose this upload.
//! let etag = storage.part(key, &id, 1, 3, incoming).await?;
//! let parts = [PartRef { part_number: 1, etag }];
//! // Persist the ETag only AFTER the product's second authorization check.
//! storage.complete(key, &id, &parts, 3).await?;
//! // Commit metadata/quota once, outside this adapter; keep recovery markers on failure.
//! # Ok(())
//! # }
//! ```

#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod body;
mod config;

use std::{pin::Pin, sync::atomic::Ordering, time::Duration};

use aws_sdk_s3::{
    Client,
    config::{
        BehaviorVersion, Credentials, Region, RequestChecksumCalculation,
        ResponseChecksumValidation, StalledStreamProtectionConfig, retry::RetryConfig,
        timeout::TimeoutConfig,
    },
    error::{ProvideErrorMetadata, SdkError},
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
};
use futures_util::{future::poll_fn, stream};
use http_body::Body;

/// Owned byte chunks; this narrow re-export is the binary boundary, not an SDK model.
pub use bytes::Bytes;
pub use config::StorageConfig;
/// The public stream trait used by [`StorageStream`].
pub use futures_core::Stream;

/// A demand-driven owned binary stream. Sources map their errors to [`StorageError::Body`].
pub type StorageStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send + 'static>>;
/// Adapter result; errors never include raw signed requests, credentials, or endpoint URLs.
pub type Result<T> = std::result::Result<T, StorageError>;
/// The application transfer protocol's maximum part size (8 MiB).
pub const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
/// Maximum durable multipart part number.
pub const MAX_PARTS: u16 = 10_000;
/// Maximum records fetched in either cleanup listing per pass.
pub const CLEANUP_LIMIT: i32 = 100;

/// Stable owned storage failures. Product handlers must map these to their public error schema.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// Configuration is invalid before any request is made.
    #[error("invalid storage configuration: {0}")]
    InvalidConfig(&'static str),
    /// Caller supplied an invalid key, part, range, or owner ID.
    #[error("invalid storage input: {0}")]
    InvalidInput(&'static str),
    /// Incoming or outgoing byte stream failed validation or transport.
    #[error("storage stream failed: {0}")]
    Body(&'static str),
    /// S3 rejected an operation. Only status and error code cross the vendor boundary.
    #[error("storage {operation} failed (HTTP {status:?}, code {code:?})")]
    Service {
        /// Owned operation name.
        operation: &'static str,
        /// HTTP status if a response was received.
        status: Option<u16>,
        /// S3 error code if a structured response was decoded.
        code: Option<String>,
    },
    /// Transport, timeout, or SDK construction failure without a valid service response.
    #[error("storage {operation} transport failed")]
    Transport {
        /// Owned operation name.
        operation: &'static str,
    },
    /// Storage returned missing or inconsistent metadata.
    #[error("invalid storage response: {0}")]
    Protocol(&'static str),
    /// Completed bytes do not match the durable upload's expected length.
    #[error("completed object length mismatch: expected {expected}, received {actual}")]
    SizeMismatch {
        /// Durable product expectation.
        expected: u64,
        /// Actual HEAD length.
        actual: u64,
    },
}

/// Durable part reference persisted by the server after authorization and a successful upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartRef {
    /// One-based part number, at most [`MAX_PARTS`].
    pub part_number: u16,
    /// Opaque ETag, including any quotes returned by S3.
    pub etag: String,
}

/// Metadata returned by HEAD. Missing content length is a protocol error, not zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectHead {
    /// Exact object size in bytes.
    pub size: u64,
    /// Stored content type if returned by storage.
    pub content_type: Option<String>,
    /// Opaque object ETag if returned by storage.
    pub etag: Option<String>,
}

/// Streamed GET response. The product server supplies its own authorized safe HTTP headers.
pub struct ObjectRead {
    /// Download stream; dropping it cancels local consumption.
    pub body: StorageStream,
    /// Response-body byte length, not the full object's size for a range request.
    pub size: u64,
    /// HTTP 200 for a full object, 206 for a single range.
    pub status: u16,
    /// S3's `bytes start-end/total` value for a partial response.
    pub content_range: Option<String>,
    /// Stored content type; must not override product attachment/sandbox policy.
    pub content_type: Option<String>,
    /// Opaque object ETag.
    pub etag: Option<String>,
}

/// One exact-key unfinished multipart upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnfinishedUpload {
    /// Durable upload ID; not a client credential.
    pub upload_id: String,
}

/// At most 100 scanned records, filtered by exact key before being exposed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnfinishedPage {
    /// Exact-key uploads only; prefix neighbours are never included.
    pub uploads: Vec<UnfinishedUpload>,
    /// More records may exist. This is a first-page observation, not a cursor or snapshot.
    /// The pinned RustFS version has no valid multipart continuation metadata.
    pub pending: bool,
}

/// Result of one exact-key cleanup pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AbortPage {
    /// Number of abort operations that succeeded or returned true `NoSuchUpload`.
    pub aborted: usize,
    /// A first-page sweep may leave more work; repeat the sweep, not an invented cursor.
    pub pending: bool,
}

/// One bounded objects-only owner sweep. This never claims to clean multipart sessions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectPurgeResult {
    /// Number of objects deleted in this pass (at most 100).
    pub deleted: usize,
    /// A listing was truncated; another pass is required. A durable tombstone must also catch
    /// late in-flight writes even when this is false. This is not a point-in-time snapshot.
    pub pending: bool,
}

/// Cloneable server-only owned client. No vendor models or SDK client escape this type.
#[derive(Clone)]
pub struct ObjectStorage {
    client: Client,
    bucket: String,
}

impl ObjectStorage {
    /// Validate explicit configuration and construct a client without network I/O.
    /// Requires a Tokio runtime for subsequent requests. There is no ambient credential chain.
    pub fn new(config: StorageConfig) -> Result<Self> {
        config.validate()?;
        let sdk = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(config.endpoint)
            .region(Region::new(config.region))
            .credentials_provider(Credentials::new(
                config.access_key_id,
                config.secret_access_key,
                None,
                None,
                "hyori-explicit",
            ))
            .force_path_style(true)
            // An ambiguous begin must not allocate another unknown upload. Streaming bodies
            // are non-replayable; product durable state owns retries and reconciliation.
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(5))
                    .read_timeout(Duration::from_secs(30))
                    .operation_timeout(Duration::from_secs(120))
                    .operation_attempt_timeout(Duration::from_secs(120))
                    .build(),
            )
            .build();
        Ok(Self {
            client: Client::from_conf(sdk),
            bucket: config.bucket,
        })
    }

    /// HEAD the configured bucket; create only on HTTP 404. Permission errors and outages fail.
    pub async fn ensure_bucket(&self) -> Result<()> {
        match self.client.head_bucket().bucket(&self.bucket).send().await {
            Ok(_) => Ok(()),
            Err(error)
                if error
                    .raw_response()
                    .is_some_and(|r| r.status().as_u16() == 404) =>
            {
                self.client
                    .create_bucket()
                    .bucket(&self.bucket)
                    .send()
                    .await
                    .map_err(|e| failure("create_bucket", &e))?;
                Ok(())
            }
            Err(error) => Err(failure("head_bucket", &error)),
        }
    }

    /// Start a multipart upload and return its durable ID. Do not blindly retry an ambiguous
    /// response; keep an exact-key cleanup marker to discover unknown duplicate sessions.
    pub async fn begin(&self, key: &str, mime_type: &str) -> Result<String> {
        config::validate_key(key)?;
        if mime_type.is_empty()
            || mime_type.len() > 255
            || !mime_type.is_ascii()
            || mime_type.bytes().any(|b| b.is_ascii_control())
        {
            return Err(StorageError::InvalidInput("invalid MIME type"));
        }
        let result = self
            .client
            .create_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .content_type(mime_type)
            .send()
            .await
            .map_err(|e| failure("begin", &e))?;
        required(result.upload_id, "missing multipart upload ID")
    }

    /// Stream an exact-length numbered part (0–8 MiB), returning its ETag. Repeated part numbers
    /// replace that part remotely. The caller owns concurrent admission and authorization.
    /// No file is collected or producer task spawned. Drop the future to cancel local work.
    /// Zero-byte parts still require source EOF and are sent to S3 as real upload-part requests.
    pub async fn part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: u16,
        length: u64,
        source: StorageStream,
    ) -> Result<String> {
        config::validate_key(key)?;
        validate_upload_id(upload_id)?;
        if !(1..=MAX_PARTS).contains(&part_number) || length > CHUNK_SIZE {
            return Err(StorageError::InvalidInput(
                "part number or length outside protocol bounds",
            ));
        }
        let (mut body, verified) = body::ExactBody::new(source, length);
        let byte_stream = if length == 0 {
            // HTTP implementations may omit polling a Content-Length: 0 body entirely.
            tokio::time::timeout(Duration::from_secs(120), async {
                while let Some(frame) = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
                    frame?;
                }
                Ok(())
            })
            .await
            .map_err(|_| StorageError::Body("empty source did not finish"))??;
            ByteStream::from(Bytes::new())
        } else {
            ByteStream::from_body_1_x(body)
        };
        let result = self
            .client
            .upload_part()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(i32::from(part_number))
            .content_length(length as i64)
            .body(byte_stream)
            // The response cannot start until the incoming part has streamed to storage.
            // Keep other operations' short read bound without cutting a live writer at 30s.
            .customize()
            .config_override(
                aws_sdk_s3::config::Builder::new()
                    .timeout_config(
                        TimeoutConfig::builder()
                            .connect_timeout(Duration::from_secs(5))
                            .read_timeout(Duration::from_secs(120))
                            .operation_timeout(Duration::from_secs(120))
                            .operation_attempt_timeout(Duration::from_secs(120))
                            .build(),
                    )
                    // The product bounds incoming idle time and the writer's lifetime.
                    // The SDK's 5s upload-stall grace cuts valid, intermittently arriving parts.
                    .stalled_stream_protection(StalledStreamProtectionConfig::disabled()),
            )
            .send()
            .await
            .map_err(|e| failure("part", &e))?;
        if !verified.load(Ordering::Acquire) {
            return Err(StorageError::Body(
                "storage acknowledged an unverified source",
            ));
        }
        required(result.e_tag, "missing uploaded part ETag")
    }

    /// Complete sorted, contiguous durable references. Invalid-part/auth errors fail closed.
    /// A vanished upload, transport ambiguity, or server failure permits replay only when HEAD
    /// at this unique immutable key proves the exact expected length. Every success verifies HEAD.
    pub async fn complete(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[PartRef],
        expected_size: u64,
    ) -> Result<ObjectHead> {
        config::validate_key(key)?;
        validate_upload_id(upload_id)?;
        let sorted = completion_parts(parts)?;
        if expected_size > CHUNK_SIZE * u64::from(MAX_PARTS) {
            return Err(StorageError::InvalidInput(
                "object exceeds multipart protocol maximum",
            ));
        }
        let request = self
            .client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(sorted))
                    .build(),
            )
            .send()
            .await;
        if let Err(error) = request {
            if !completion_may_have_succeeded(&error) {
                return Err(failure("complete", &error));
            }
            match self.head(key).await {
                Ok(head) if head.size == expected_size => return Ok(head),
                _ => return Err(failure("complete", &error)),
            }
        }
        let head = self.head(key).await?;
        if head.size != expected_size {
            return Err(StorageError::SizeMismatch {
                expected: expected_size,
                actual: head.size,
            });
        }
        Ok(head)
    }

    /// Read exact object metadata. Missing objects, missing lengths and outages are errors.
    pub async fn head(&self, key: &str) -> Result<ObjectHead> {
        config::validate_key(key)?;
        let result = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| failure("head", &e))?;
        Ok(ObjectHead {
            size: content_length(result.content_length)?,
            content_type: result.content_type,
            etag: result.e_tag,
        })
    }

    /// Abort a session; only the structured S3 `NoSuchUpload` code is tolerated, never a generic
    /// 404, missing bucket, permission failure, or transport outage.
    pub async fn abort(&self, key: &str, upload_id: &str) -> Result<()> {
        config::validate_key(key)?;
        validate_upload_id(upload_id)?;
        match self
            .client
            .abort_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(error)
                if error.as_service_error().and_then(|e| e.code()) == Some("NoSuchUpload") =>
            {
                Ok(())
            }
            Err(error) => Err(failure("abort", &error)),
        }
    }

    /// Observe the first bounded page of unfinished records, returning exact-key matches only.
    /// This is NOT a complete enumeration or a paginated reader. RustFS alpha.85 returns one
    /// extra entry and omits continuation markers; request 99 so at most 100 can be returned.
    /// Destructive callers drain this first page repeatedly via [`Self::abort_unfinished`].
    pub async fn unfinished(&self, key: &str) -> Result<UnfinishedPage> {
        config::validate_key(key)?;
        let result = self
            .client
            .list_multipart_uploads()
            .bucket(&self.bucket)
            .prefix(key)
            .max_uploads(CLEANUP_LIMIT - 1)
            .send()
            .await
            .map_err(|e| failure("unfinished", &e))?;
        if result.uploads().len() > CLEANUP_LIMIT as usize {
            return Err(StorageError::Protocol("multipart listing exceeded bound"));
        }
        let pending = result
            .is_truncated
            .ok_or(StorageError::Protocol("missing multipart truncation flag"))?
            || result.uploads().len() >= (CLEANUP_LIMIT - 1) as usize;
        let mut uploads = Vec::new();
        for upload in result.uploads.unwrap_or_default() {
            let listed_key = required(upload.key, "missing listed multipart key")?;
            if listed_key == key {
                uploads.push(UnfinishedUpload {
                    upload_id: required(upload.upload_id, "missing listed upload ID")?,
                });
            }
        }
        Ok(UnfinishedPage { uploads, pending })
    }

    /// Abort at most one listing page of exact-key uploads, optionally preserving the active ID.
    /// Repeated first-page sweeps drain leftovers and catch ambiguous or late create responses.
    pub async fn abort_unfinished(
        &self,
        key: &str,
        retained_upload_id: Option<&str>,
    ) -> Result<AbortPage> {
        let page = self.unfinished(key).await?;
        let mut aborted = 0;
        for upload in page.uploads {
            if Some(upload.upload_id.as_str()) != retained_upload_id {
                self.abort(key, &upload.upload_id).await?;
                aborted += 1;
            }
        }
        Ok(AbortPage {
            aborted,
            pending: page.pending,
        })
    }

    /// Stream the full object or one validated HTTP byte range (`bytes=a-b`, `bytes=a-`, or
    /// `bytes=-n`). Multiple ranges and malformed/unsatisfiable input fail, never downgrade to
    /// an entire file. A 416 service response remains an error with its status available.
    pub async fn read(&self, key: &str, range: Option<&str>) -> Result<ObjectRead> {
        config::validate_key(key)?;
        if let Some(range) = range {
            validate_range(range)?;
        }
        let result = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .set_range(range.map(str::to_owned))
            .send()
            .await
            .map_err(|e| failure("read", &e))?;
        let size = content_length(result.content_length)?;
        if range.is_some() != result.content_range.is_some() {
            return Err(StorageError::Protocol("unexpected range response"));
        }
        if let (Some(requested), Some(received)) = (range, result.content_range.as_deref()) {
            validate_content_range(requested, received, size)?;
        }
        let body = stream::try_unfold((result.body, size), |(mut body, remaining)| async move {
            match body.next().await {
                Some(Ok(bytes)) if bytes.len() as u64 <= remaining => {
                    let left = remaining - bytes.len() as u64;
                    Ok(Some((bytes, (body, left))))
                }
                Some(Ok(_)) => Err(StorageError::Body("download exceeds content length")),
                Some(Err(_)) => Err(StorageError::Body("download transport failed")),
                None if remaining == 0 => Ok(None),
                None => Err(StorageError::Body("download shorter than content length")),
            }
        });
        Ok(ObjectRead {
            body: Box::pin(body),
            size,
            status: if range.is_some() { 206 } else { 200 },
            content_range: result.content_range,
            content_type: result.content_type,
            etag: result.e_tag,
        })
    }

    /// Delete one exact object. S3's successful delete of an already absent key is idempotent;
    /// bucket, permission and transport errors are never ignored.
    pub async fn remove(&self, key: &str) -> Result<()> {
        config::validate_key(key)?;
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| failure("remove", &e))?;
        Ok(())
    }

    /// Delete up to 100 OBJECTS ONLY from a validated owner namespace. Repeat while pending;
    /// successful deletion drains the first page without a cursor that could skip late inserts.
    ///
    /// This is deliberately not an account purge or a multipart-prefix purge. RustFS alpha.85
    /// hashes multipart prefixes as exact keys, silently reporting an empty owner listing while
    /// uploads exist. The product must commit an object-key intent BEFORE every begin, retain
    /// those keys/tombstones through account deletion, and drain [`Self::abort_unfinished`] for
    /// each durable key. No complete multipart-prefix cleanup capability is exposed here.
    pub async fn purge_owner_objects(&self, owner_id: &str) -> Result<ObjectPurgeResult> {
        let prefix = config::owner_prefix(owner_id)?;
        let page = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(&prefix)
            .max_keys(CLEANUP_LIMIT)
            .send()
            .await
            .map_err(|e| failure("purge_objects", &e))?;
        if page.contents().len() > CLEANUP_LIMIT as usize {
            return Err(StorageError::Protocol("object listing exceeded bound"));
        }
        let objects_pending = page
            .is_truncated
            .ok_or(StorageError::Protocol("missing object truncation flag"))?;
        let mut deleted = 0;
        for object in page.contents.unwrap_or_default() {
            let key = required(object.key, "missing purge object key")?;
            if !key.starts_with(&prefix) {
                return Err(StorageError::Protocol(
                    "object listing escaped owner prefix",
                ));
            }
            self.remove(&key).await?;
            deleted += 1;
        }
        Ok(ObjectPurgeResult {
            deleted,
            pending: objects_pending,
        })
    }
}

fn failure<E: ProvideErrorMetadata>(operation: &'static str, error: &SdkError<E>) -> StorageError {
    let status = error.raw_response().map(|r| r.status().as_u16());
    let code = error
        .as_service_error()
        .and_then(|e| e.code())
        .map(str::to_owned);
    if status.is_some() || code.is_some() {
        StorageError::Service {
            operation,
            status,
            code,
        }
    } else {
        StorageError::Transport { operation }
    }
}

fn completion_may_have_succeeded<E: ProvideErrorMetadata>(error: &SdkError<E>) -> bool {
    match error {
        SdkError::TimeoutError(_) | SdkError::DispatchFailure(_) | SdkError::ResponseError(_) => {
            true
        }
        SdkError::ServiceError(context) => {
            context.err().code() == Some("NoSuchUpload") || context.raw().status().as_u16() >= 500
        }
        _ => false,
    }
}

fn content_length(length: Option<i64>) -> Result<u64> {
    length
        .and_then(|n| u64::try_from(n).ok())
        .ok_or(StorageError::Protocol("missing or invalid content length"))
}

fn required(value: Option<String>, message: &'static str) -> Result<String> {
    value
        .filter(|s| !s.is_empty())
        .ok_or(StorageError::Protocol(message))
}

fn validate_upload_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 4096 || id.bytes().any(|b| b.is_ascii_control()) {
        return Err(StorageError::InvalidInput("invalid multipart upload ID"));
    }
    Ok(())
}

fn completion_parts(parts: &[PartRef]) -> Result<Vec<CompletedPart>> {
    if parts.is_empty() || parts.len() > usize::from(MAX_PARTS) {
        return Err(StorageError::InvalidInput("invalid completion part count"));
    }
    let mut sorted: Vec<_> = parts.iter().collect();
    sorted.sort_unstable_by_key(|part| part.part_number);
    if sorted.iter().enumerate().any(|(index, part)| {
        usize::from(part.part_number) != index + 1
            || part.etag.is_empty()
            || part.etag.len() > 1024
            || part.etag.bytes().any(|b| b.is_ascii_control())
    }) {
        return Err(StorageError::InvalidInput(
            "completion needs unique contiguous numbered ETags",
        ));
    }
    Ok(sorted
        .into_iter()
        .map(|part| {
            CompletedPart::builder()
                .part_number(i32::from(part.part_number))
                .e_tag(&part.etag)
                .build()
        })
        .collect())
}

fn validate_content_range(requested: &str, received: &str, size: u64) -> Result<()> {
    let invalid = || StorageError::Protocol("invalid or mismatched content range");
    let number = |value: &str| -> Result<u64> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        value.parse().map_err(|_| invalid())
    };
    let (bounds, total) = received
        .strip_prefix("bytes ")
        .and_then(|value| value.split_once('/'))
        .ok_or_else(invalid)?;
    let (start, end) = bounds.split_once('-').ok_or_else(invalid)?;
    let (start, end, total) = (number(start)?, number(end)?, number(total)?);
    if total == 0 || start > end || end >= total || end - start + 1 != size {
        return Err(invalid());
    }
    let (requested_start, requested_end) = requested
        .strip_prefix("bytes=")
        .and_then(|value| value.split_once('-'))
        .ok_or_else(invalid)?;
    let expected_start = if requested_start.is_empty() {
        total.saturating_sub(number(requested_end)?)
    } else {
        number(requested_start)?
    };
    let expected_end = if requested_start.is_empty() || requested_end.is_empty() {
        total - 1
    } else {
        number(requested_end)?.min(total - 1)
    };
    if start != expected_start || end != expected_end {
        return Err(invalid());
    }
    Ok(())
}

fn validate_range(range: &str) -> Result<()> {
    let invalid = || StorageError::InvalidInput("expected one HTTP byte range");
    let value = range.strip_prefix("bytes=").ok_or_else(invalid)?;
    let (start, end) = value.split_once('-').ok_or_else(invalid)?;
    let number = |s: &str| -> Result<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        s.parse().map_err(|_| invalid())
    };
    match (start.is_empty(), end.is_empty()) {
        (true, true) => Err(invalid()),
        (true, false) => {
            if number(end)? > 0 {
                Ok(())
            } else {
                Err(invalid())
            }
        }
        (false, true) => {
            number(start)?;
            Ok(())
        }
        (false, false) => {
            if number(start)? <= number(end)? {
                Ok(())
            } else {
                Err(invalid())
            }
        }
    }
}

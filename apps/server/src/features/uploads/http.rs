use crate::{
    AppState,
    auth::digest,
    config::{DOWNLOAD_QUEUE_PER_PRINCIPAL, DOWNLOAD_QUEUE_WAIT, DOWNLOADS_PER_PRINCIPAL},
    error::ApiError,
    features::{
        auth::api::Id,
        files::{self, api::DownloadInput},
        uploads::service::{UploadsService, storage_error},
    },
    rpc::{RequestContext, validate_origin},
};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use hyori_storage::{Bytes, StorageError};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// A body that yields no chunk, or a reader that accepts none, for this long is abandoned.
const IDLE: Duration = Duration::from_secs(30);
/// No single download body may outlive this, however steadily it is read.
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(900);
/// Chunks buffered between storage and a reader; a stalled reader therefore pins only this much.
const DOWNLOAD_BUFFER: usize = 2;
/// Browsers may store immutable media only when every reuse reauthorizes at the server.
pub(crate) const REVALIDATE_CACHE_CONTROL: &str = "private, no-cache";

pub(crate) async fn put(
    State(state): State<Arc<AppState>>,
    Path((id, number)): Path<(String, u32)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    validate_origin(request.headers(), &state.config.origin)?;
    if request.headers().get_all("content-length").iter().count() != 1
        || request.headers().contains_key("transfer-encoding")
    {
        return Err(ApiError::invalid());
    }
    let length = request
        .headers()
        .get("content-length")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(ApiError::invalid)?;
    if length > hyori_storage::CHUNK_SIZE {
        return Err(ApiError::invalid());
    }
    let context = state.request_context(request.headers());
    // A silently dead connection must fail the part (and release its lease) promptly, not after
    // the storage adapter's two-minute request bound. Admission waiting must not restart the
    // first-chunk clock: an empty queued body has already spent that idle time.
    let body = stream::unfold(
        Some((
            request.into_body().into_data_stream(),
            tokio::time::Instant::now() + IDLE,
        )),
        |body| async move {
            let (mut body, deadline) = body?;
            match tokio::time::timeout_at(deadline, body.next()).await {
                Ok(Some(Ok(bytes))) => {
                    Some((Ok(bytes), Some((body, tokio::time::Instant::now() + IDLE))))
                }
                Ok(None) => None,
                Ok(Some(Err(_))) => {
                    Some((Err(StorageError::Body("incoming request failed")), None))
                }
                Err(_) => Some((Err(StorageError::Body("incoming request stalled")), None)),
            }
        },
    );
    let service = UploadsService::new(state.clone(), context);
    let acknowledged = service
        .write_part(id, number, length, Box::pin(body))
        .await?;
    Ok(Json(serde_json::json!({"ok":true,"value":acknowledged})).into_response())
}
#[derive(Deserialize)]
pub(crate) struct DownloadQuery {
    pub(crate) version: Option<String>,
    pub(crate) revision: Option<i64>,
}
pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<DownloadQuery>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    validate_origin(request.headers(), &state.config.origin)?;
    let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
    if query.revision.is_some_and(|value| value < 0)
        || (query.version.is_some() && query.revision.is_some())
    {
        return Err(ApiError::invalid());
    }
    let descriptor = files::read_content(
        &state,
        state.request_context(request.headers()),
        DownloadInput {
            id: Id(id),
            version_id: query.version.map(Id),
        },
        query.revision,
    )
    .await?;
    stream_content(
        storage,
        descriptor,
        request.headers(),
        permit,
        "application/octet-stream",
        "attachment",
    )
    .await
}

/// Concurrent download bodies per principal. A burst (a photo grid's thumbnails) briefly
/// queues for a slot; entries exist only while a request holds or awaits one.
#[derive(Default)]
pub(crate) struct PrincipalLimiter(Arc<Mutex<HashMap<String, Principal>>>);
struct Principal {
    slots: Arc<tokio::sync::Semaphore>,
    /// Holders plus waiters.
    users: usize,
}
/// One principal's admitted body; dropping it frees the slot.
pub(crate) struct PrincipalSlot {
    _slot: tokio::sync::OwnedSemaphorePermit,
    _user: PrincipalUser,
}
struct PrincipalUser {
    principals: Arc<Mutex<HashMap<String, Principal>>>,
    key: String,
}
impl Drop for PrincipalUser {
    fn drop(&mut self) {
        let mut principals = self
            .principals
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(principal) = principals.get_mut(&self.key) {
            principal.users -= 1;
            if principal.users == 0 {
                principals.remove(&self.key);
            }
        }
    }
}
impl PrincipalLimiter {
    /// Wait up to `wait` for one of `limit` slots, unless `limit + queue` requests already hold
    /// or await this principal's slots. Waiting holds no process-wide download admission.
    pub(crate) async fn acquire(
        &self,
        key: String,
        limit: usize,
        queue: usize,
        wait: Duration,
    ) -> Option<PrincipalSlot> {
        let (slots, user) = {
            let mut principals = self.0.lock().unwrap_or_else(PoisonError::into_inner);
            let principal = principals.entry(key.clone()).or_insert_with(|| Principal {
                slots: Arc::new(tokio::sync::Semaphore::new(limit)),
                users: 0,
            });
            if principal.users >= limit + queue {
                return None;
            }
            principal.users += 1;
            (
                principal.slots.clone(),
                PrincipalUser {
                    principals: self.0.clone(),
                    key,
                },
            )
        };
        let slot = tokio::time::timeout(wait, slots.acquire_owned())
            .await
            .ok()?
            .ok()?;
        Some(PrincipalSlot {
            _slot: slot,
            _user: user,
        })
    }
}
tokio::task_local! {
    /// Handed from the route middleware to whichever body producer the handler starts.
    static DOWNLOAD_SLOT: RefCell<Option<PrincipalSlot>>;
}
/// A budget key, not authority: handlers still authorize every credential against the database.
/// Sessions and grant sets are keyed by digest; credential-less callers by peer address.
fn principal(headers: &HeaderMap, peer: Option<IpAddr>) -> String {
    let context = RequestContext::from_headers(headers);
    if let Some(session) = context.session {
        format!("session:{}", digest(&session))
    } else if !context.grants.is_empty() {
        format!("grants:{}", digest(&context.grants.join(".")))
    } else {
        peer.map_or_else(|| "peer:unknown".into(), |ip| format!("peer:{ip}"))
    }
}
/// Route layer for every download-like route: bound a principal's bodies before any database or
/// storage work, and let the body producer hold the slot for the body's lifetime.
pub(crate) async fn admit_principal(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip());
    let key = principal(request.headers(), peer);
    let Some(slot) = state
        .download_principals
        .acquire(
            key,
            DOWNLOADS_PER_PRINCIPAL,
            DOWNLOAD_QUEUE_PER_PRINCIPAL,
            DOWNLOAD_QUEUE_WAIT,
        )
        .await
    else {
        return ApiError::unavailable().into_response();
    };
    DOWNLOAD_SLOT
        .scope(RefCell::new(Some(slot)), next.run(request))
        .await
}

/// Call only after resolving a descriptor through the current request's authorization path.
/// The object key names immutable bytes; hash it rather than exposing storage identities.
pub(crate) fn content_etag(descriptor: &files::ContentDescriptor) -> String {
    format!(
        "\"{}\"",
        digest(&format!(
            "{}:{}:{}",
            descriptor.object_key, descriptor.size, descriptor.mime_type
        ))
    )
}

pub(crate) fn not_modified(
    descriptor: &files::ContentDescriptor,
    headers: &HeaderMap,
) -> Option<Response> {
    let etag = content_etag(descriptor);
    let matches = headers.get_all("if-none-match").iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value.split(',').any(|tag| {
                let tag = tag.trim();
                tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
            })
        })
    });
    matches.then(|| {
        (
            StatusCode::NOT_MODIFIED,
            [
                ("etag", etag),
                ("cache-control", REVALIDATE_CACHE_CONTROL.into()),
                ("x-content-type-options", "nosniff".into()),
                (
                    "content-security-policy",
                    "sandbox; default-src 'none'".into(),
                ),
            ],
        )
            .into_response()
    })
}

/// Every binary route shares range, length, admission lifetime and deadline policy.
pub(crate) async fn stream_content(
    storage: &hyori_storage::ObjectStorage,
    descriptor: files::ContentDescriptor,
    headers: &axum::http::HeaderMap,
    permit: tokio::sync::OwnedSemaphorePermit,
    content_type: &str,
    disposition: &str,
) -> Result<Response, ApiError> {
    // Only thumbnails and format-gated previews are inline. Original/editor downloads remain
    // no-store. Authorization has already completed, including when no storage read is needed.
    let revalidate = disposition == "inline";
    if revalidate && let Some(response) = not_modified(&descriptor, headers) {
        return Ok(response);
    }
    let size = descriptor.size as u64;
    // A cached partial response must never be combined with bytes from a different object.
    // We emit no Last-Modified validator, so only the exact strong ETag can satisfy If-Range.
    let range_allowed = !revalidate
        || headers.get("if-range").is_none_or(|value| {
            value
                .to_str()
                .is_ok_and(|value| value == content_etag(&descriptor))
        });
    let range = if let Some(value) = headers.get("range").filter(|_| range_allowed) {
        if headers.get_all("range").iter().count() != 1 {
            return Ok(unsatisfiable(size));
        }
        let Some((start, end)) = value
            .to_str()
            .ok()
            .and_then(|value| parse_range(value, size))
        else {
            return Ok(unsatisfiable(size));
        };
        Some((start, end))
    } else {
        None
    };
    let range_header = range.map(|(start, end)| format!("bytes={start}-{end}"));
    let read = storage
        .read(&descriptor.object_key, range_header.as_deref())
        .await
        .map_err(storage_error)?;
    let expected = range.map_or(size, |(start, end)| end - start + 1);
    if read.size != expected {
        return Err(ApiError::unavailable());
    }
    let slot = DOWNLOAD_SLOT
        .try_with(|slot| slot.borrow_mut().take())
        .ok()
        .flatten();
    let mut body = Box::pin(relay(read.body, (permit, slot), IDLE));
    // Headers flushed ahead of any body bytes lose Content-Length behind some proxies (Bun.serve),
    // so send them with the first chunk. A storage failure before it then answers 503, not 200.
    let first = if expected == 0 {
        None
    } else {
        match body.next().await {
            Some(Ok(chunk)) => Some(Ok::<_, StorageError>(chunk)),
            _ => return Err(ApiError::unavailable()),
        }
    };
    let body = stream::iter(first).chain(body);
    let encoded = url::form_urlencoded::byte_serialize(descriptor.name.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    let mut response = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header("content-length", expected.to_string())
        .header("content-type", content_type)
        .header("accept-ranges", "bytes")
        .header(
            "content-disposition",
            format!("{disposition}; filename=\"download\"; filename*=UTF-8''{encoded}"),
        )
        .header("content-security-policy", "sandbox; default-src 'none'")
        .header(
            "cache-control",
            if revalidate {
                REVALIDATE_CACHE_CONTROL
            } else {
                "no-store"
            },
        )
        .header("x-content-type-options", "nosniff");
    if revalidate {
        response = response.header("etag", content_etag(&descriptor));
    }
    if let Some((start, end)) = range {
        response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(Body::from_stream(body))
        .map_err(|_| ApiError::unavailable())
}

/// Hyper polls a response body only while the client reads, so deadlines inside the body never
/// fire for a stalled reader. A spawned producer owns the storage stream and the admission, and
/// gives up when storage or the reader is idle for `idle` or the body passes its deadline.
/// The returned body then fails rather than ending early, so a truncated download is never
/// mistaken for a complete one.
fn relay<A: Send + 'static>(
    mut source: hyori_storage::StorageStream,
    admission: A,
    idle: Duration,
) -> impl futures_util::Stream<Item = Result<Bytes, StorageError>> + Send + 'static {
    let (sender, receiver) = tokio::sync::mpsc::channel(DOWNLOAD_BUFFER);
    let finished = Arc::new(AtomicBool::new(false));
    let complete = finished.clone();
    tokio::spawn(async move {
        let _admission = admission;
        let deadline = tokio::time::Instant::now() + DOWNLOAD_DEADLINE;
        let until = || deadline.min(tokio::time::Instant::now() + idle);
        loop {
            let item = match tokio::time::timeout_at(until(), source.next()).await {
                Ok(Some(item)) => item,
                Ok(None) => {
                    complete.store(true, Ordering::Release);
                    return;
                }
                Err(_) => Err(StorageError::Body("download deadline exceeded")),
            };
            if let Err(error) = &item {
                crate::observability::storage_error();
                tracing::error!(category = "storage", %error, "storage stream failed");
            }
            let failed = item.is_err();
            let sent = tokio::time::timeout_at(until(), sender.send(item)).await;
            if failed || !matches!(sent, Ok(Ok(()))) {
                return;
            }
        }
    });
    stream::unfold(Some(receiver), move |receiver| {
        let finished = finished.clone();
        async move {
            let mut receiver = receiver?;
            match receiver.recv().await {
                Some(item) => {
                    let failed = item.is_err();
                    Some((item, (!failed).then_some(receiver)))
                }
                None if finished.load(Ordering::Acquire) => None,
                None => Some((Err(StorageError::Body("download abandoned")), None)),
            }
        }
    })
}
fn unsatisfiable(size: u64) -> Response {
    (
        StatusCode::RANGE_NOT_SATISFIABLE,
        [
            ("content-range", format!("bytes */{size}")),
            ("content-length", "0".into()),
            ("cache-control", "no-store".into()),
            ("x-content-type-options", "nosniff".into()),
            (
                "content-security-policy",
                "sandbox; default-src 'none'".into(),
            ),
        ],
        Body::empty(),
    )
        .into_response()
}
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size - 1));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        size - 1
    } else {
        number(end)?.min(size - 1)
    };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}
#[cfg(test)]
mod tests {
    use super::*;
    const TEST_IDLE: Duration = Duration::from_millis(50);
    #[tokio::test]
    async fn stalled_reader_releases_admission_and_the_body_then_fails() {
        let admission = Arc::new(());
        let source = stream::iter((0..8).map(|_| Ok(Bytes::from_static(b"chunk"))));
        let mut body = Box::pin(relay(Box::pin(source), admission.clone(), TEST_IDLE));
        assert_eq!(body.next().await.unwrap().unwrap(), "chunk");
        // The reader stops; the producer fills its buffer, then gives up after the idle bound.
        tokio::time::sleep(TEST_IDLE * 4).await;
        assert_eq!(Arc::strong_count(&admission), 1);
        let mut failed = false;
        while let Some(item) = body.next().await {
            failed |= item.is_err();
        }
        assert!(failed, "an abandoned body must not end like a complete one");
    }
    #[tokio::test]
    async fn read_body_completes_and_releases_admission() {
        let admission = Arc::new(());
        let source = stream::iter([Ok(Bytes::from_static(b"ab")), Ok(Bytes::from_static(b"c"))]);
        let body = relay(Box::pin(source), admission.clone(), TEST_IDLE);
        let chunks = body.collect::<Vec<_>>().await;
        assert!(chunks.iter().all(Result::is_ok));
        assert_eq!(chunks.len(), 2);
        tokio::task::yield_now().await;
        assert_eq!(Arc::strong_count(&admission), 1);
    }
    #[tokio::test]
    async fn principal_slots_queue_briefly_are_bounded_per_key_and_released_on_drop() {
        let limiter = PrincipalLimiter::default();
        let acquire = |key: &str| limiter.acquire(key.into(), 2, 1, TEST_IDLE);
        let (first, second) = (acquire("a").await.unwrap(), acquire("a").await.unwrap());
        // A third request waits for a slot and gets one as soon as a holder finishes.
        let waiting = acquire("a");
        let release = async {
            tokio::time::sleep(TEST_IDLE / 4).await;
            drop(first);
        };
        let (third, ()) = tokio::join!(waiting, release);
        let third = third.expect("a queued request takes the freed slot");
        // With both slots held, a waiter times out rather than queueing forever.
        assert!(acquire("a").await.is_none());
        assert!(
            acquire("b").await.is_some(),
            "other principals are independent"
        );
        drop((second, third));
        assert!(limiter.0.lock().unwrap().is_empty());
    }
    #[test]
    fn single_ranges_are_bounded_and_malformed_ranges_never_become_full_downloads() {
        for (value, expected) in [
            ("bytes=1-3", Some((1, 3))),
            ("bytes=2-", Some((2, 9))),
            ("bytes=-3", Some((7, 9))),
            ("bytes=-99", Some((0, 9))),
            ("bytes=8-99", Some((8, 9))),
            ("bytes=10-", None),
            ("bytes=-0", None),
            ("bytes=2-1", None),
            ("bytes=0-1,4-5", None),
            ("bytes=+1-2", None),
        ] {
            assert_eq!(parse_range(value, 10), expected, "{value}");
        }
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
}

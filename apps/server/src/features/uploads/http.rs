use crate::{
    AppState,
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
    extract::{Path, Query, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use hyori_storage::StorageError;
use serde::Deserialize;
use std::{sync::Arc, time::Duration};

pub(crate) async fn put(
    State(state): State<Arc<AppState>>,
    Path((id, number)): Path<(String, u32)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
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
    let context = RequestContext::from_headers(request.headers());
    let body = request
        .into_body()
        .into_data_stream()
        .map(|r| r.map_err(|_| StorageError::Body("incoming request failed")));
    let service = UploadsService::new(state.clone(), context);
    let status = service
        .write_part(id, number, length, Box::pin(body), permit)
        .await?;
    Ok(Json(serde_json::json!({"ok":true,"value":status})).into_response())
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
        RequestContext::from_headers(request.headers()),
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

/// Both binary routes share range, length, admission lifetime and deadline policy.
pub(crate) async fn stream_content(
    storage: &hyori_storage::ObjectStorage,
    descriptor: files::ContentDescriptor,
    headers: &axum::http::HeaderMap,
    permit: tokio::sync::OwnedSemaphorePermit,
    content_type: &str,
    disposition: &str,
) -> Result<Response, ApiError> {
    let size = descriptor.size as u64;
    let range = if let Some(value) = headers.get("range") {
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    // The semaphore permit lives with the response body, not just until headers are sent.
    let body = stream::try_unfold(
        (read.body, permit, deadline),
        |(mut body, permit, deadline)| async move {
            let until = deadline.min(tokio::time::Instant::now() + Duration::from_secs(30));
            match tokio::time::timeout_at(until, body.next()).await {
                Ok(Some(Ok(bytes))) => Ok(Some((bytes, (body, permit, deadline)))),
                Ok(Some(Err(error))) => Err(error),
                Ok(None) => Ok(None),
                Err(_) => Err(StorageError::Body("download deadline exceeded")),
            }
        },
    );
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
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff");
    if let Some((start, end)) = range {
        response = response.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    response
        .body(Body::from_stream(body))
        .map_err(|_| ApiError::unavailable())
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
    use super::parse_range;
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

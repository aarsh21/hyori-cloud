use crate::{
    AppState,
    error::ApiError,
    features::{
        auth::api::Id,
        files::{api::DownloadInput, read_content},
        uploads::{
            http::{DownloadQuery, not_modified, stream_content},
            service::storage_error,
        },
    },
    rpc::validate_origin,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    response::Response,
};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};

pub(crate) const MEDIA: [&str; 8] = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
];
const HEADER_LIMIT: u64 = 4096;
pub(crate) fn supported(mime: &str) -> bool {
    MEDIA.contains(&mime)
}
/// Revision is a cache identity, never authorization or permission to select older current bytes.
pub(crate) fn preview_url(id: &str, version: Option<&str>, revision: i64) -> String {
    format!(
        "/api/storage/previews/{id}?revision={revision}{}",
        version
            .map(|id| format!("&version={id}"))
            .unwrap_or_default()
    )
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
    let descriptor = read_content(
        &state,
        state.request_context(request.headers()),
        DownloadInput {
            id: Id(id),
            version_id: query.version.map(Id),
        },
        None,
    )
    .await?;
    if !supported(&descriptor.mime_type) || descriptor.size <= 0 {
        return Err(ApiError::invalid());
    }
    // Every request reauthorizes above. Reusing previously format-gated immutable bytes needs
    // neither another header read nor another full storage stream.
    if let Some(response) = not_modified(&descriptor, request.headers()) {
        return Ok(response);
    }
    // Inspect the same immutable object that will be streamed, including for nonzero byte ranges.
    // This is a format gate, not a decoder, antivirus scan or fidelity guarantee.
    let length = (descriptor.size as u64).min(HEADER_LIMIT);
    let bytes = tokio::time::timeout(Duration::from_secs(30), async {
        let mut read = storage
            .read(
                &descriptor.object_key,
                Some(&format!("bytes=0-{}", length - 1)),
            )
            .await
            .map_err(storage_error)?;
        if read.size != length {
            return Err(ApiError::unavailable());
        }
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(chunk) = read.body.next().await {
            let chunk = chunk.map_err(storage_error)?;
            if bytes.len() + chunk.len() > length as usize {
                return Err(ApiError::unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != length as usize {
            return Err(ApiError::unavailable());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    let mime = detected_type(&bytes, descriptor.size as u64)
        .filter(|mime| *mime == descriptor.mime_type)
        .ok_or_else(ApiError::invalid)?;
    stream_content(
        storage,
        descriptor,
        request.headers(),
        permit,
        mime,
        "inline",
    )
    .await
}

/// Fail closed on unsupported/ambiguous headers. Never use a filename or supplied MIME to sniff.
fn detected_type(bytes: &[u8], size: u64) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        && bytes.len() >= 33
        && bytes[8..16] == *b"\0\0\0\rIHDR"
        && bytes[16..20] != [0; 4]
        && bytes[20..24] != [0; 4]
    {
        return Some("image/png");
    }
    if bytes.len() >= 4
        && bytes[..3] == [0xff, 0xd8, 0xff]
        && matches!(bytes[3], 0xe0..=0xef | 0xdb | 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf | 0xfe)
    {
        return Some("image/jpeg");
    }
    if bytes.len() >= 13
        && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
        && bytes[6..8] != [0; 2]
        && bytes[8..10] != [0; 2]
    {
        return Some("image/gif");
    }
    if bytes.len() >= 20
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
        && matches!(&bytes[12..16], b"VP8 " | b"VP8L" | b"VP8X")
        && u64::from(u32::from_le_bytes(bytes[4..8].try_into().ok()?)) + 8 == size
    {
        return Some("image/webp");
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        if length < 16 || length > bytes.len() || length as u64 > size || !length.is_multiple_of(4)
        {
            return None;
        }
        let major = &bytes[8..12];
        if matches!(major, b"avif" | b"avis")
            || bytes[16..length]
                .as_chunks::<4>()
                .0
                .iter()
                .any(|brand| matches!(brand, b"avif" | b"avis"))
        {
            return Some("image/avif");
        }
        if major == b"qt  " {
            return Some("video/quicktime");
        }
        if matches!(
            major,
            b"isom" | b"iso2" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"avc1" | b"M4V "
        ) {
            return Some("video/mp4");
        }
        return None;
    }
    if webm_header(bytes) {
        return Some("video/webm");
    }
    None
}
fn vint(bytes: &[u8]) -> Option<(usize, usize)> {
    let first = *bytes.first()?;
    let width = first.leading_zeros() as usize + 1;
    if width > 8 || bytes.len() < width {
        return None;
    }
    let mut value = usize::from(first & ((0xff_u16 >> width) as u8));
    for byte in &bytes[1..width] {
        value = value.checked_mul(256)?.checked_add(usize::from(*byte))?;
    }
    Some((value, width))
}
fn webm_header(bytes: &[u8]) -> bool {
    fn parse(bytes: &[u8]) -> Option<()> {
        if !bytes.starts_with(b"\x1a\x45\xdf\xa3") {
            return None;
        }
        let (length, width) = vint(bytes.get(4..)?)?;
        let mut remaining = bytes.get(4 + width..4 + width + length)?;
        let mut found = false;
        while !remaining.is_empty() {
            let id_width = remaining[0].leading_zeros() as usize + 1;
            if id_width > 4 {
                return None;
            }
            let id = remaining.get(..id_width)?;
            let (length, width) = vint(remaining.get(id_width..)?)?;
            let value = remaining.get(id_width + width..id_width + width + length)?;
            if id == b"\x42\x82" {
                if found || value != b"webm" {
                    return None;
                }
                found = true;
            }
            remaining = remaining.get(id_width + width + length..)?;
        }
        found.then_some(())
    }
    parse(bytes).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_identity_changes_with_revision_without_losing_historical_selection() {
        assert_ne!(preview_url("file", None, 0), preview_url("file", None, 1));
        assert_eq!(
            preview_url("file", Some("version"), 2),
            "/api/storage/previews/file?revision=2&version=version"
        );
    }
    #[test]
    fn active_unknown_and_truncated_content_is_not_inline_media() {
        for bytes in [
            b"<html><script>alert(1)</script>".as_slice(),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            b"%PDF-1.7",
            b"<?xml version='1.0'?>",
            b"unknown",
            b"\x89PNG\r\n\x1a\n",
            b"RIFF\0\0\0\0WEBP",
        ] {
            assert_eq!(detected_type(bytes, bytes.len() as u64), None);
        }
    }
    #[test]
    fn ebml_requires_a_bounded_structural_webm_doctype() {
        assert_eq!(
            detected_type(b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm", 12),
            Some("video/webm")
        );
        assert_eq!(detected_type(b"\x1a\x45\xdf\xa3junkwebm", 12), None);
        assert_eq!(
            detected_type(b"\x1a\x45\xdf\xa3\xff\x42\x82\x84webm", 12),
            None
        );
    }
    #[test]
    fn bmff_distinguishes_avif_quicktime_and_mp4() {
        for (brand, mime) in [
            (b"avif", "image/avif"),
            (b"qt  ", "video/quicktime"),
            (b"isom", "video/mp4"),
        ] {
            let mut bytes = b"\0\0\0\x10ftypxxxx\0\0\0\0".to_vec();
            bytes[8..12].copy_from_slice(brand);
            assert_eq!(detected_type(&bytes, 16), Some(mime));
        }
    }
}

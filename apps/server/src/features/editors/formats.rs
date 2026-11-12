use crate::{error::ApiError, features::editors::api::*};
use futures_util::StreamExt;
use hyori_storage::ObjectStorage;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) fn app_name(app: &EditorApp) -> &'static str {
    match app {
        EditorApp::Wordcraft => "wordcraft",
        EditorApp::Gridcraft => "gridcraft",
        EditorApp::Deckcraft => "deckcraft",
        EditorApp::Pdfcraft => "pdfcraft",
    }
}
pub(crate) fn version(app: &EditorApp) -> &'static str {
    match app {
        EditorApp::Wordcraft => "0.14.0",
        EditorApp::Gridcraft => "0.15.0",
        EditorApp::Deckcraft => "0.14.1-hyori-host.2",
        EditorApp::Pdfcraft => "0.17.0",
    }
}
pub(crate) fn max_bytes(app: &EditorApp) -> u64 {
    match app {
        EditorApp::Deckcraft => 64 * 1024 * 1024,
        _ => 32 * 1024 * 1024,
    }
}
pub(crate) fn validate_transport_name(app: &EditorApp, name: &str) -> Result<(), ApiError> {
    // Modified Deck's JavaScript bridge counts UTF-16 units, unlike the Files scalar-count contract.
    if *app == EditorApp::Deckcraft && name.encode_utf16().count() > 255 {
        return Err(ApiError::invalid());
    }
    Ok(())
}
/// Lowercased: `Report.DOCX` is the same format as `report.docx`.
pub(crate) fn extension(name: &str) -> Result<String, ApiError> {
    let (_, extension) = name.rsplit_once('.').ok_or_else(ApiError::invalid)?;
    Ok(extension.to_ascii_lowercase())
}
pub(crate) const APPS: [EditorApp; 4] = [
    EditorApp::Wordcraft,
    EditorApp::Gridcraft,
    EditorApp::Deckcraft,
    EditorApp::Pdfcraft,
];
pub(crate) fn input_extensions(app: &EditorApp) -> &'static [&'static str] {
    match app {
        EditorApp::Wordcraft => &[".docx"],
        EditorApp::Gridcraft => &[".xlsx"],
        EditorApp::Deckcraft => &[".deckcraft", ".pptx"],
        EditorApp::Pdfcraft => &[".pdf"],
    }
}
pub(crate) fn app(name: &str) -> Result<EditorApp, ApiError> {
    let suffix = format!(".{}", extension(name)?);
    APPS.into_iter()
        .find(|app| input_extensions(app).contains(&suffix.as_str()))
        .ok_or_else(ApiError::invalid)
}
pub(crate) fn mime(name: &str) -> Result<&'static str, ApiError> {
    match extension(name)?.as_str() {
        "docx" => Ok("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Ok("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => Ok("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "deckcraft" => Ok("application/vnd.storyteller.deckcraft+zip"),
        "pdf" => Ok("application/pdf"),
        _ => Err(ApiError::invalid()),
    }
}
pub(crate) fn outputs(app: &EditorApp) -> Vec<EditorOutputFormat> {
    let document = match app {
        EditorApp::Wordcraft => ".docx",
        EditorApp::Gridcraft => ".xlsx",
        EditorApp::Deckcraft => ".deckcraft",
        EditorApp::Pdfcraft => ".pdf",
    };
    let mut outputs = vec![EditorOutputFormat {
        extension: document.into(),
        kind: EditorOutputKind::Document,
        max_bytes: Some(crate::features::auth::api::Bytes(max_bytes(app))),
    }];
    if matches!(app, EditorApp::Wordcraft | EditorApp::Deckcraft) {
        outputs.push(EditorOutputFormat {
            extension: ".pdf".into(),
            kind: EditorOutputKind::Export,
            max_bytes: Some(crate::features::auth::api::Bytes(max_bytes(
                &EditorApp::Pdfcraft,
            ))),
        });
    }
    outputs
}
pub(crate) fn replacement(name: &str) -> Option<String> {
    if extension(name).ok().as_deref() == Some("pptx") {
        None
    } else {
        Some(name.into())
    }
}
pub(crate) fn validate_output(
    app: &EditorApp,
    name: &str,
    intent: &EditorIntent,
) -> Result<(), ApiError> {
    validate_transport_name(app, name)?;
    let extension = format!(".{}", extension(name)?);
    let format = outputs(app)
        .into_iter()
        .find(|format| format.extension == extension)
        .ok_or_else(ApiError::invalid)?;
    if (format.kind == EditorOutputKind::Export) != (*intent == EditorIntent::Export) {
        return Err(ApiError::invalid());
    }
    Ok(())
}

/// Signature/container identification and streaming digest, not document parsing or fidelity proof.
/// Retains at most 4 KiB of header plus 1 MiB of tail; never decompresses archive members.
pub(crate) async fn inspect(
    storage: &ObjectStorage,
    key: &str,
    name: &str,
    size: u64,
    expected_hash: Option<&str>,
) -> Result<(), ApiError> {
    tokio::time::timeout(Duration::from_secs(120), async {
        if size == 0 || size > max_bytes(&app(name)?) {
            return Err(ApiError::invalid());
        }
        if expected_hash.is_none() {
            let head = read_range(storage, key, 0, size.min(4096) - 1).await?;
            let tail = read_range(storage, key, size.saturating_sub(1024 * 1024), size - 1).await?;
            return identify(name, &head, &tail, size);
        }
        let mut read = storage
            .read(key, None)
            .await
            .map_err(crate::features::uploads::service::storage_error)?;
        if read.size != size || size == 0 || size > max_bytes(&app(name)?) {
            return Err(ApiError::invalid());
        }
        let mut hash = Sha256::new();
        let mut seen = 0_u64;
        let mut head = Vec::new();
        let mut tail = Vec::new();
        const TAIL: usize = 1024 * 1024;
        while let Some(chunk) = read.body.next().await {
            let chunk = chunk.map_err(crate::features::uploads::service::storage_error)?;
            seen = seen
                .checked_add(chunk.len() as u64)
                .ok_or_else(ApiError::invalid)?;
            if seen > size {
                return Err(ApiError::invalid());
            }
            hash.update(&chunk);
            let head_needed = (4096_usize.saturating_sub(head.len())).min(chunk.len());
            head.extend_from_slice(&chunk[..head_needed]);
            if chunk.len() >= TAIL {
                tail.clear();
                tail.extend_from_slice(&chunk[chunk.len() - TAIL..]);
            } else {
                let remove = (tail.len() + chunk.len()).saturating_sub(TAIL);
                tail.drain(..remove);
                tail.extend_from_slice(&chunk);
            }
        }
        if seen != size
            || expected_hash.is_some_and(|expected| hex::encode(hash.finalize()) != expected)
        {
            return Err(ApiError::invalid());
        }
        identify(name, &head, &tail, size)
    })
    .await
    .map_err(|_| ApiError::unavailable())?
}
async fn read_range(
    storage: &ObjectStorage,
    key: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, ApiError> {
    let expected = end - start + 1;
    let mut read = storage
        .read(key, Some(&format!("bytes={start}-{end}")))
        .await
        .map_err(crate::features::uploads::service::storage_error)?;
    if read.size != expected {
        return Err(ApiError::invalid());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = read.body.next().await {
        let chunk = chunk.map_err(crate::features::uploads::service::storage_error)?;
        if bytes.len() as u64 + chunk.len() as u64 > expected {
            return Err(ApiError::invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != expected {
        return Err(ApiError::invalid());
    }
    Ok(bytes)
}
fn number(bytes: &[u8], offset: usize, width: usize) -> Result<u64, ApiError> {
    let slice = bytes
        .get(offset..offset + width)
        .ok_or_else(ApiError::invalid)?;
    Ok(slice
        .iter()
        .enumerate()
        .fold(0, |n, (i, b)| n | (u64::from(*b) << (8 * i))))
}
fn identify(name: &str, head: &[u8], tail: &[u8], size: u64) -> Result<(), ApiError> {
    let extension = extension(name)?;
    if extension == "pdf" {
        if (head.starts_with(b"%PDF-1.") || head.starts_with(b"%PDF-2."))
            && tail.windows(5).rev().take(1024).any(|b| b == b"%%EOF")
        {
            return Ok(());
        }
        return Err(ApiError::invalid());
    }
    if !head.starts_with(b"PK\x03\x04") {
        return Err(ApiError::invalid());
    }
    let end = tail
        .windows(4)
        .rposition(|b| b == b"PK\x05\x06")
        .ok_or_else(ApiError::invalid)?;
    if number(tail, end + 4, 2)? != 0
        || number(tail, end + 6, 2)? != 0
        || end + 22 + number(tail, end + 20, 2)? as usize != tail.len()
    {
        return Err(ApiError::invalid());
    }
    let count = number(tail, end + 10, 2)?;
    let length = number(tail, end + 12, 4)?;
    let offset = number(tail, end + 16, 4)?;
    let tail_start = size
        .checked_sub(tail.len() as u64)
        .ok_or_else(ApiError::invalid)?;
    if count == 0
        || count > 4096
        || number(tail, end + 8, 2)? != count
        || offset < tail_start
        || offset + length != tail_start + end as u64
    {
        return Err(ApiError::invalid());
    }
    let mut cursor = (offset - tail_start) as usize;
    let mut expanded = 0_u64;
    let mut names = std::collections::HashSet::new();
    for _ in 0..count {
        if tail.get(cursor..cursor + 4) != Some(b"PK\x01\x02") {
            return Err(ApiError::invalid());
        }
        let flags = number(tail, cursor + 8, 2)?;
        let method = number(tail, cursor + 10, 2)?;
        let compressed = number(tail, cursor + 20, 4)?;
        let uncompressed = number(tail, cursor + 24, 4)?;
        expanded += uncompressed;
        let name_len = number(tail, cursor + 28, 2)? as usize;
        let extra_len = number(tail, cursor + 30, 2)? as usize;
        let comment_len = number(tail, cursor + 32, 2)? as usize;
        let entry_name = tail
            .get(cursor + 46..cursor + 46 + name_len)
            .ok_or_else(ApiError::invalid)?;
        if flags & 1 != 0
            || !matches!(method, 0 | 8)
            || expanded > 256 * 1024 * 1024
            || compressed > size
            || number(tail, cursor + 42, 4)? >= offset
            || !names.insert(entry_name)
        {
            return Err(ApiError::invalid());
        }
        cursor += 46 + name_len + extra_len + comment_len;
    }
    if cursor != end {
        return Err(ApiError::invalid());
    }
    let required: &[&[u8]] = match extension.as_str() {
        "docx" => &[b"[Content_Types].xml", b"word/document.xml"],
        "xlsx" => &[b"[Content_Types].xml", b"xl/workbook.xml"],
        "pptx" => &[b"[Content_Types].xml", b"ppt/presentation.xml"],
        "deckcraft" => &[b"mimetype", b"presentation.json"],
        _ => return Err(ApiError::invalid()),
    };
    if !required.iter().all(|name| names.contains(name)) {
        return Err(ApiError::invalid());
    }
    if extension == "deckcraft" {
        let mime = b"application/vnd.storyteller.deckcraft+zip";
        let n = number(head, 26, 2)? as usize;
        let extra = number(head, 28, 2)? as usize;
        if number(head, 8, 2)? != 0
            || head.get(30..30 + n) != Some(b"mimetype")
            || number(head, 18, 4)? != mime.len() as u64
            || head.get(30 + n + extra..30 + n + extra + mime.len()) != Some(mime)
        {
            return Err(ApiError::invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extensions_match_regardless_of_case() {
        assert!(app("Report.DOCX").is_ok_and(|app| app == EditorApp::Wordcraft));
        assert!(app("Deck.PpTx").is_ok_and(|app| app == EditorApp::Deckcraft));
        assert_eq!(mime("Scan.PDF").ok(), Some("application/pdf"));
        assert_eq!(replacement("Deck.PPTX"), None);
        assert_eq!(replacement("Sheet.XLSX").as_deref(), Some("Sheet.XLSX"));
        assert!(validate_output(&EditorApp::Wordcraft, "Out.PDF", &EditorIntent::Export).is_ok());
    }

    #[test]
    fn rejects_spoofed_pdf_and_empty_or_mismatched_containers() {
        for name in ["x.pdf", "x.docx", "x.xlsx", "x.pptx", "x.deckcraft"] {
            assert!(identify(name, b"<html>", b"<html>", 6).is_err());
        }
        assert!(identify("x.pdf", b"%PDF-1.7", b"truncated", 17).is_err());
    }
    #[test]
    fn deck_transport_rejects_utf16_overflow_without_changing_files_name_policy() {
        let name = format!("{}.deckcraft", "😀".repeat(123));
        assert!(name.chars().count() <= 255);
        assert!(validate_transport_name(&EditorApp::Deckcraft, &name).is_err());
        assert!(
            validate_transport_name(
                &EditorApp::Deckcraft,
                &format!("{}.deckcraft", "😀".repeat(122))
            )
            .is_ok()
        );
    }
    #[test]
    fn official_versions_match_pinned_manifest_and_deck_is_separate() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../tooling/artcraft/manifest.json"
        ))
        .unwrap();
        let text = manifest.to_string();
        for app in [
            EditorApp::Wordcraft,
            EditorApp::Gridcraft,
            EditorApp::Pdfcraft,
        ] {
            assert!(text.contains(&format!("{}-web-{}.zip", app_name(&app), version(&app))));
        }
        let build: serde_json::Value = serde_json::from_str(include_str!("../../../../../tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/build-manifest.json")).unwrap();
        assert_eq!(build["artifactVersion"], "0.14.1-hyori-host.1");
        assert_ne!(build["artifactVersion"], version(&EditorApp::Deckcraft));
        assert_eq!(build["deployable"], false);
    }
}

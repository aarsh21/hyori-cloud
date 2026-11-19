use futures_util::StreamExt;
use hyori_media_worker::{
    CAPTURE_HEADER, CAPTURE_PATH, CaptureMetadata, ErrorBody, Failure, MAX_CAPTURE, MAX_INPUT,
    MAX_OUTPUT, png_dimensions, webp_dimensions,
};
use hyori_storage::StorageStream;
use std::{path::Path, time::Duration};

#[derive(Clone)]
pub(crate) struct WorkerClient(reqwest::Client);
impl WorkerClient {
    pub fn new(socket: &Path) -> Result<Self, crate::error::ApiError> {
        reqwest::Client::builder()
            .unix_socket(socket)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(90))
            .build()
            .map(Self)
            .map_err(|_| crate::error::ApiError::unavailable())
    }
    /// Old/unreachable workers report no identity: ordinary bounded processing continues, but no
    /// terminal job is automatically reset until an identified decoder is actually connected.
    pub async fn decoder_revision(&self) -> Option<String> {
        let response = self
            .0
            .get(format!(
                "http://localhost{}",
                hyori_media_worker::DECODER_PATH
            ))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() || response.content_length()? > 128 {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        if bytes.len() > 128 {
            return None;
        }
        let revision: String = serde_json::from_slice(&bytes).ok()?;
        (revision.len() == 64 && revision.bytes().all(|b| b.is_ascii_hexdigit()))
            .then_some(revision)
    }
    pub async fn supports_capture(&self) -> bool {
        self.0
            .head(format!("http://localhost{CAPTURE_PATH}"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|response| response.status() == reqwest::StatusCode::NO_CONTENT)
    }
    pub async fn capture(
        &self,
        mime: &str,
        size: u64,
        body: StorageStream,
    ) -> Result<CaptureMetadata, ErrorBody> {
        let response = self.request(CAPTURE_PATH, mime, size, body, None).await?;
        let success = response.status().is_success();
        let bytes = collect(response, MAX_CAPTURE).await?;
        if !success {
            return Err(worker_error(&bytes));
        }
        serde_json::from_slice::<CaptureMetadata>(&bytes)
            .map(CaptureMetadata::validated)
            .map_err(|_| Failure::Unavailable.into())
    }
    pub async fn derive(
        &self,
        mime: &str,
        size: u64,
        body: StorageStream,
        revision: Option<&str>,
    ) -> Result<(Vec<u8>, &'static str, Option<CaptureMetadata>), ErrorBody> {
        let response = self
            .request(hyori_media_worker::PATH, mime, size, body, revision)
            .await?;
        let success = response.status().is_success();
        let mime = match response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
        {
            Some("image/webp") => "image/webp",
            Some("image/png") => "image/png", // Allow an old worker during a rolling upgrade.
            _ if !success => "application/json",
            _ => return Err(Failure::InvalidMedia.into()),
        };
        let capture = response
            .headers()
            .get(CAPTURE_HEADER)
            .map(|value| value.as_bytes())
            .filter(|bytes| bytes.len() <= MAX_CAPTURE)
            .and_then(|bytes| serde_json::from_slice::<CaptureMetadata>(bytes).ok())
            .map(CaptureMetadata::validated);
        let bytes = collect(response, MAX_OUTPUT).await?;
        if !success {
            return Err(worker_error(&bytes));
        }
        match mime {
            "image/webp" => webp_dimensions(&bytes),
            _ => png_dimensions(&bytes),
        }
        .ok_or(Failure::InvalidMedia)?;
        Ok((bytes, mime, capture))
    }
    async fn request(
        &self,
        path: &str,
        mime: &str,
        size: u64,
        body: StorageStream,
        revision: Option<&str>,
    ) -> Result<reqwest::Response, ErrorBody> {
        if size == 0 || size > MAX_INPUT {
            return Err(Failure::ResourceLimit.into());
        }
        let mut request = self
            .0
            .post(format!("http://localhost{path}"))
            .header("content-length", size)
            .header("content-type", "application/octet-stream")
            .header("x-hyori-media-type", mime);
        if let Some(revision) = revision {
            request = request.header("x-hyori-decoder", revision);
        }
        request
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await
            .map_err(|_| Failure::Unavailable.into())
    }
}

fn worker_error(bytes: &[u8]) -> ErrorBody {
    serde_json::from_slice(bytes).unwrap_or_else(|_| Failure::Unavailable.into())
}

async fn collect(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, ErrorBody> {
    let length = response
        .content_length()
        .filter(|v| *v <= limit as u64)
        .ok_or(Failure::ResourceLimit)?;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(length as usize);
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), stream.next())
        .await
        .map_err(|_| Failure::Timeout)?
    {
        let chunk = chunk.map_err(|_| Failure::Unavailable)?;
        if bytes.len() + chunk.len() > limit {
            return Err(Failure::ResourceLimit.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != length as usize {
        return Err(Failure::Unavailable.into());
    }
    Ok(bytes)
}

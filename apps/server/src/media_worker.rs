use futures_util::StreamExt;
use hyori_media_worker::{
    CAPTURE_HEADER, CAPTURE_PATH, CAPTURE_VERSION, CAPTURE_VERSION_HEADER, CaptureMetadata,
    DECODER_PATH, DISPLAY_PATH, ErrorBody, Failure, MAX_CAPTURE, MAX_DISPLAY_OUTPUT, MAX_INPUT,
    MAX_OUTPUT, SAMPLED_PATH, SOURCE_SIZE_HEADER, display_dimensions, png_dimensions,
    webp_dimensions,
};
use hyori_storage::StorageStream;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub(crate) struct WorkerInput {
    pub size: u64,
    pub body: StorageStream,
    pub sampled_source_size: Option<u64>,
}

#[derive(Clone)]
pub(crate) struct WorkerClient {
    http: reqwest::Client,
    availability: Arc<Mutex<Option<(Instant, bool)>>>,
}
impl WorkerClient {
    pub fn new(socket: &Path) -> Result<Self, crate::error::ApiError> {
        reqwest::Client::builder()
            .unix_socket(socket)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(90))
            .build()
            .map(|http| Self {
                http,
                availability: Arc::default(),
            })
            .map_err(|_| crate::error::ApiError::unavailable())
    }
    pub async fn available(&self) -> bool {
        let mut cache = self.availability.lock().await;
        if let Some((checked, available)) = *cache
            && checked.elapsed() < Duration::from_secs(5)
        {
            return available;
        }
        // This lightweight route doesn't wait for the decoder's job slot; a busy worker is online.
        let available = self
            .http
            .head(format!("http://localhost{DECODER_PATH}"))
            .timeout(Duration::from_millis(100))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        *cache = Some((Instant::now(), available));
        available
    }
    /// Old/unreachable workers report no identity: ordinary bounded processing continues, but no
    /// terminal job is automatically reset until an identified decoder is actually connected.
    pub async fn decoder_revision(&self) -> Option<String> {
        let response = self
            .http
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
        self.http
            .head(format!("http://localhost{CAPTURE_PATH}"))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|response| {
                response.status() == reqwest::StatusCode::NO_CONTENT
                    && response
                        .headers()
                        .get(CAPTURE_VERSION_HEADER)
                        .and_then(|v| v.to_str().ok()?.parse::<u8>().ok())
                        == Some(CAPTURE_VERSION)
            })
    }
    pub async fn capture(
        &self,
        mime: &str,
        input: WorkerInput,
    ) -> Result<CaptureMetadata, ErrorBody> {
        let response = self.request(CAPTURE_PATH, mime, input, None).await?;
        let success = response.status().is_success();
        let bytes = collect(response, MAX_CAPTURE).await?;
        if !success {
            return Err(worker_error(&bytes));
        }
        serde_json::from_slice::<CaptureMetadata>(&bytes)
            .map(CaptureMetadata::validated)
            .ok()
            .filter(|capture| capture.version == CAPTURE_VERSION)
            .ok_or_else(|| Failure::Unavailable.into())
    }
    pub async fn derive(
        &self,
        mime: &str,
        input: WorkerInput,
        revision: Option<&str>,
        display: bool,
    ) -> Result<(Vec<u8>, &'static str, Option<CaptureMetadata>), ErrorBody> {
        let path = if display {
            DISPLAY_PATH
        } else if input.sampled_source_size.is_some() {
            SAMPLED_PATH
        } else {
            hyori_media_worker::PATH
        };
        let response = self.request(path, mime, input, revision).await?;
        let success = response.status().is_success();
        let mime = match response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
        {
            Some("image/webp") => "image/webp",
            Some("image/png") if !display => "image/png", // Legacy thumbnail during rolling upgrade.
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
        let limit = if display && success {
            MAX_DISPLAY_OUTPUT
        } else {
            MAX_OUTPUT
        };
        let bytes = collect(response, limit).await?;
        if !success {
            return Err(worker_error(&bytes));
        }
        match mime {
            "image/webp" if display => display_dimensions(&bytes),
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
        input: WorkerInput,
        revision: Option<&str>,
    ) -> Result<reqwest::Response, ErrorBody> {
        if input.size == 0 || input.size > MAX_INPUT {
            return Err(Failure::ResourceLimit.into());
        }
        let mut request = self
            .http
            .post(format!("http://localhost{path}"))
            .header("content-length", input.size)
            .header("content-type", "application/octet-stream")
            .header("x-hyori-media-type", mime);
        if let Some(revision) = revision {
            request = request.header("x-hyori-decoder", revision);
        }
        if let Some(size) = input.sampled_source_size {
            request = request.header(SOURCE_SIZE_HEADER, size);
        }
        let response = request
            .body(reqwest::Body::wrap_stream(input.body))
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        // An older worker has no sampled route. Treat that like an unavailable capability, not
        // an invalid source. Its eventual replacement can retry the job using its new identity.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Failure::Unavailable.into());
        }
        Ok(response)
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

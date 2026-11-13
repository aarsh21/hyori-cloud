use futures_util::StreamExt;
use hyori_media_worker::{
    ErrorBody, Failure, MAX_INPUT, MAX_OUTPUT, png_dimensions, webp_dimensions,
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
    pub async fn derive(
        &self,
        mime: &str,
        size: u64,
        body: StorageStream,
        revision: Option<&str>,
    ) -> Result<(Vec<u8>, &'static str), ErrorBody> {
        if size == 0 || size > MAX_INPUT {
            return Err(Failure::ResourceLimit.into());
        }
        let mut request = self
            .0
            .post(format!("http://localhost{}", hyori_media_worker::PATH))
            .header("content-length", size)
            .header("content-type", "application/octet-stream")
            .header("x-hyori-media-type", mime);
        if let Some(revision) = revision {
            request = request.header("x-hyori-decoder", revision);
        }
        let response = request
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await
            .map_err(|_| Failure::Unavailable)?;
        let success = response.status().is_success();
        let length = response
            .content_length()
            .filter(|v| *v <= MAX_OUTPUT as u64)
            .ok_or(Failure::ResourceLimit)?;
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
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .map_err(|_| Failure::Timeout)?
        {
            let chunk = chunk.map_err(|_| Failure::Unavailable)?;
            if bytes.len() + chunk.len() > MAX_OUTPUT {
                return Err(Failure::ResourceLimit.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != length as usize {
            return Err(Failure::Unavailable.into());
        }
        if !success {
            return Err(serde_json::from_slice::<ErrorBody>(&bytes)
                .unwrap_or_else(|_| Failure::Unavailable.into()));
        }
        match mime {
            "image/webp" => webp_dimensions(&bytes),
            _ => png_dimensions(&bytes),
        }
        .ok_or(Failure::InvalidMedia)?;
        Ok((bytes, mime))
    }
}

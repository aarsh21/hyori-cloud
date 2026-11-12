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
    pub async fn derive(
        &self,
        mime: &str,
        size: u64,
        body: StorageStream,
    ) -> Result<(Vec<u8>, &'static str), Failure> {
        if size == 0 || size > MAX_INPUT {
            return Err(Failure::ResourceLimit);
        }
        let response = self
            .0
            .post(format!("http://localhost{}", hyori_media_worker::PATH))
            .header("content-length", size)
            .header("content-type", "application/octet-stream")
            .header("x-hyori-media-type", mime)
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
            _ => return Err(Failure::InvalidMedia),
        };
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::with_capacity(length as usize);
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .map_err(|_| Failure::Timeout)?
        {
            let chunk = chunk.map_err(|_| Failure::Unavailable)?;
            if bytes.len() + chunk.len() > MAX_OUTPUT {
                return Err(Failure::ResourceLimit);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != length as usize {
            return Err(Failure::Unavailable);
        }
        if !success {
            return Err(serde_json::from_slice::<ErrorBody>(&bytes)
                .map(|v| v.error)
                .unwrap_or(Failure::Unavailable));
        }
        match mime {
            "image/webp" => webp_dimensions(&bytes),
            _ => png_dimensions(&bytes),
        }
        .ok_or(Failure::InvalidMedia)?;
        Ok((bytes, mime))
    }
}

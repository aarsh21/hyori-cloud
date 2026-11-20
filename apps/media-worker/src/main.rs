#![forbid(unsafe_code)]
mod capture;
mod decode;
mod identity;
mod isolation;
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use hyori_media_worker::{
    CAPTURE_HEADER, CAPTURE_PATH, CAPTURE_VERSION, CAPTURE_VERSION_HEADER, DISPLAY_PATH, ErrorBody,
    Failure, Format, MAX_INPUT, SAMPLED_PATH, SOURCE_SIZE_HEADER, VIDEO_SAMPLE_HEAD,
    VIDEO_SAMPLE_TAIL, display_dimensions, webp_dimensions,
};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};

struct Worker {
    admission: tokio::sync::Semaphore,
    revision: String,
}

struct Error(ErrorBody);
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self(Failure::Unavailable.into())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self.0.error {
            Failure::Busy | Failure::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Failure::Timeout => StatusCode::REQUEST_TIMEOUT,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        (status, axum::Json(self.0)).into_response()
    }
}
async fn process(
    State(worker): State<Arc<Worker>>,
    request: Request<Body>,
) -> Result<Response, Error> {
    // A replacement between identity lookup and POST cannot consume an old decoder's retry.
    if request
        .headers()
        .get("x-hyori-decoder")
        .is_some_and(|v| v != worker.revision.as_str())
    {
        return Err(Error(Failure::Busy.into()));
    }
    let _permit = worker
        .admission
        .try_acquire()
        .map_err(|_| Error(Failure::Busy.into()))?;
    tokio::time::timeout(Duration::from_secs(60), derive(request))
        .await
        .map_err(|_| Error(Failure::Timeout.into()))?
}
async fn derive(request: Request<Body>) -> Result<Response, Error> {
    let capture_only = request.uri().path() == CAPTURE_PATH;
    let sample = request.uri().path() == SAMPLED_PATH;
    let display = request.uri().path() == DISPLAY_PATH;
    let headers = request.headers();
    if headers.get_all("content-length").iter().count() != 1
        || headers.contains_key("transfer-encoding")
    {
        return Err(Error(Failure::InvalidMedia.into()));
    }
    let length = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0 && *v <= MAX_INPUT)
        .ok_or(Error(Failure::ResourceLimit.into()))?;
    let format = headers
        .get("x-hyori-media-type")
        .and_then(|v| v.to_str().ok())
        .and_then(Format::from_mime)
        .ok_or(Error(Failure::Unsupported.into()))?;
    if display && !matches!(format, Format::Heic) {
        return Err(Error(Failure::Unsupported.into()));
    }
    let source_size = if sample || (capture_only && headers.contains_key(SOURCE_SIZE_HEADER)) {
        if !format.is_video() || length != VIDEO_SAMPLE_HEAD + VIDEO_SAMPLE_TAIL {
            return Err(Error(Failure::InvalidMedia.into()));
        }
        Some(
            headers
                .get(SOURCE_SIZE_HEADER)
                .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
                .filter(|v| *v > MAX_INPUT && *v <= format.max_source())
                .ok_or(Error(Failure::ResourceLimit.into()))?,
        )
    } else {
        None
    };
    let directory = tempfile::Builder::new()
        .prefix("media-")
        .tempdir_in("/scratch")?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.path().join("source"))
        .await?;
    let mut body = request.into_body().into_data_stream();
    let mut remaining = length;
    let mut header = Vec::with_capacity(4096);
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), body.next())
        .await
        .map_err(|_| Error(Failure::Timeout.into()))?
    {
        let chunk = chunk.map_err(|_| Error(Failure::InvalidMedia.into()))?;
        let received = length - remaining;
        remaining = remaining
            .checked_sub(chunk.len() as u64)
            .ok_or(Error(Failure::ResourceLimit.into()))?;
        let copy = chunk.len().min(4096 - header.len());
        header.extend_from_slice(&chunk[..copy]);
        if let Some(total) = source_size
            && received <= VIDEO_SAMPLE_HEAD
            && length - remaining > VIDEO_SAMPLE_HEAD
        {
            let (head, tail) = chunk.split_at((VIDEO_SAMPLE_HEAD - received) as usize);
            file.write_all(head).await?;
            // Preserve container offsets for a trailing MP4/MOV index without filling the gap.
            file.seek(SeekFrom::Start(total - VIDEO_SAMPLE_TAIL))
                .await?;
            file.write_all(tail).await?;
        } else {
            file.write_all(&chunk).await?;
        }
    }
    if remaining != 0 || !format.accepts_header(&header) {
        return Err(Error(Failure::InvalidMedia.into()));
    }
    file.flush().await?;
    drop(file);
    if capture_only {
        let metadata = decode::capture(directory.path(), format)
            .await
            .map_err(Error)?;
        return Ok(axum::Json(metadata).into_response());
    }
    let (output, metadata, dimensions) = if display {
        let output = decode::heic_display(directory.path())
            .await
            .map_err(Error)?;
        let dimensions = display_dimensions(&output);
        (output, None, dimensions)
    } else {
        let (output, metadata) = decode::derive(directory.path(), format)
            .await
            .map_err(Error)?;
        let dimensions = webp_dimensions(&output);
        (output, Some(metadata), dimensions)
    };
    let (width, height) = dimensions.ok_or(Error(Failure::InvalidMedia.into()))?;
    let mut response = Response::builder()
        .status(200)
        .header("content-type", "image/webp")
        .header("content-length", output.len())
        .header("x-hyori-width", width)
        .header("x-hyori-height", height);
    if let Some(metadata) = metadata {
        response = response.header(
            CAPTURE_HEADER,
            serde_json::to_string(&metadata).map_err(|_| Error(Failure::Unavailable.into()))?,
        );
    }
    response
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(output))
        .map_err(|_| Error(Failure::Unavailable.into()))
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    isolation::verify()?;
    let decoder_revision = identity::fingerprint()?;
    let path = PathBuf::from(std::env::var("HYORI_MEDIA_SOCKET")?);
    if !path.is_absolute() || path.as_os_str().len() > 100 {
        return Err("absolute private Unix socket path required".into());
    }
    let parent = std::fs::metadata(path.parent().ok_or("socket parent required")?)?;
    if parent.permissions().mode() & 0o007 != 0 {
        return Err("socket directory must not be world-accessible".into());
    }
    if let Ok(old) = std::fs::symlink_metadata(&path) {
        if !old.file_type().is_socket()
            || old.uid() != parent.uid()
            || std::os::unix::net::UnixStream::connect(&path).is_ok()
        {
            return Err("socket path is occupied".into());
        }
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))?;
    let worker = Arc::new(Worker {
        admission: tokio::sync::Semaphore::new(1),
        revision: decoder_revision,
    });
    let app =
        Router::new()
            .route(hyori_media_worker::PATH, post(process))
            .route(SAMPLED_PATH, post(process))
            .route(DISPLAY_PATH, post(process))
            .route(
                CAPTURE_PATH,
                post(process).head(|| async {
                    (
                        StatusCode::NO_CONTENT,
                        [(CAPTURE_VERSION_HEADER, CAPTURE_VERSION.to_string())],
                    )
                }),
            )
            .route(
                hyori_media_worker::DECODER_PATH,
                get(|State(worker): State<Arc<Worker>>| async move {
                    axum::Json(worker.revision.clone())
                }),
            )
            .with_state(worker);
    axum::serve(listener, app).await?;
    Ok(())
}

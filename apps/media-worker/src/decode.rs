use crate::capture::{self, VideoTags};
use hyori_media_worker::{
    CAPTURE_IMAGE_PREFIX, CAPTURE_VERSION, CaptureDimensions, CaptureMetadata, DISPLAY_EDGE,
    ErrorBody, Failure, Format, MAX_DISPLAY_OUTPUT, MAX_INPUT, MAX_OUTPUT, MAX_PIXELS, Reason,
    Stage, display_dimensions, rejection_reason, webp_dimensions,
};
use serde::Deserialize;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

async fn limited(mut pipe: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let length = pipe
            .read(&mut buffer)
            .await
            .map_err(|_| Failure::Unavailable)?;
        if length == 0 {
            return Ok(bytes);
        }
        if bytes.len() + length > limit {
            return Err(Failure::ResourceLimit);
        }
        bytes.extend_from_slice(&buffer[..length]);
    }
}
async fn command(
    mut command: Command,
    cap: usize,
    seconds: u64,
    stage: Stage,
) -> Result<Vec<u8>, ErrorBody> {
    let result = async {
        command
            .env_clear()
            .env("LANG", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| Failure::Unavailable)?;
        let stdout = child.stdout.take().ok_or(Failure::Unavailable)?;
        let stderr = child.stderr.take().ok_or(Failure::Unavailable)?;
        tokio::time::timeout(Duration::from_secs(seconds), async {
            let (status, output, stderr) = tokio::try_join!(
                async { child.wait().await.map_err(|_| Failure::Unavailable) },
                limited(stdout, cap),
                limited(stderr, 8192)
            )?;
            if !status.success() {
                return Err(ErrorBody::diagnostic(
                    Failure::InvalidMedia,
                    stage,
                    rejection_reason(&stderr),
                ));
            }
            Ok(output)
        })
        .await
        .map_err(|_| Failure::Timeout)?
    }
    .await;
    result.map_err(|mut error: ErrorBody| {
        if error.diagnostic.is_none() {
            let reason = match error.error {
                Failure::ResourceLimit => Reason::OutputLimit,
                Failure::Timeout => Reason::Deadline,
                _ => Reason::ProcessUnavailable,
            };
            error.diagnostic = Some(hyori_media_worker::Diagnostic { stage, reason });
        }
        error
    })
}
fn input(command: &mut Command, format: Format) {
    command.args([
        "-v",
        "error",
        "-max_alloc",
        "67108864",
        "-threads",
        "1",
        "-probesize",
        "1048576",
        "-analyzeduration",
        "1000000",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        format.demuxer(),
        "-f",
        format.demuxer(),
    ]);
    if matches!(format, Format::Avif | Format::Mp4 | Format::Quicktime) {
        command.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
}
#[derive(Deserialize)]
struct Probe {
    streams: Vec<Stream>,
    #[serde(default)]
    format: ProbeFormat,
}
#[derive(Deserialize)]
struct Stream {
    width: Option<u32>,
    height: Option<u32>,
    codec_type: String,
    #[serde(default)]
    disposition: Disposition,
    #[serde(default)]
    side_data_list: Vec<SideData>,
}
#[derive(Default, Deserialize)]
struct Disposition {
    #[serde(default)]
    attached_pic: u8,
}
#[derive(Deserialize)]
struct SideData {
    rotation: Option<i32>,
}
#[derive(Default, Deserialize)]
struct ProbeFormat {
    #[serde(default)]
    tags: VideoTags,
}

async fn probe(directory: &Path, format: Format, tags: bool) -> Result<Probe, ErrorBody> {
    let mut probe = Command::new("/usr/bin/ffprobe");
    probe.current_dir(directory);
    input(&mut probe, format);
    probe.args([
        "-show_entries",
        if tags {
            "stream=width,height,codec_type:stream_disposition=attached_pic:stream_side_data=rotation:format_tags=creation_time,com.apple.quicktime.creationdate,location,com.apple.quicktime.location.ISO6709,com.apple.quicktime.make,com.apple.quicktime.model"
        } else {
            "stream=width,height,codec_type:stream_disposition=attached_pic:stream_side_data=rotation:format="
        },
        "-of",
        "json",
        "source",
    ]);
    serde_json::from_slice(&command(probe, 64 * 1024, 10, Stage::Probe).await?).map_err(|_| {
        ErrorBody::diagnostic(Failure::InvalidMedia, Stage::Probe, Reason::InvalidProbe)
    })
}

impl Probe {
    fn visual(&self) -> Result<&Stream, ErrorBody> {
        self.streams
            .iter()
            .find(|s| s.codec_type == "video" && s.disposition.attached_pic == 0)
            .ok_or_else(|| {
                ErrorBody::diagnostic(Failure::InvalidMedia, Stage::Probe, Reason::MissingVisual)
            })
    }
}

impl Stream {
    fn dimensions(&self) -> Option<CaptureDimensions> {
        let (width, height) = self.width.zip(self.height)?;
        Some(CaptureDimensions { width, height })
    }
    fn rotates(&self) -> bool {
        self.side_data_list
            .iter()
            .filter_map(|data| data.rotation)
            .any(|rotation| rotation.rem_euclid(180) == 90)
    }
}

async fn heic_dimensions(directory: &Path) -> Result<Option<CaptureDimensions>, ErrorBody> {
    // FFmpeg 7 reports a tiled HEIC's first tile as its first visual stream. libheif handles
    // the primary image's grid and container orientation before either call returns.
    let mut header = Command::new("/usr/bin/vipsheader");
    header.current_dir(directory).arg("source");
    let output = command(header, 8192, 10, Stage::Probe).await?;
    Ok(std::str::from_utf8(&output).ok().and_then(|line| {
        let mut words = line.split_ascii_whitespace();
        if words.next()? != "source:" {
            return None;
        }
        let (width, height) = words.next()?.split_once('x')?;
        words.last().filter(|loader| *loader == "heifload")?;
        Some(CaptureDimensions {
            width: width.parse().ok()?,
            height: height.parse().ok()?,
        })
    }))
}

async fn metadata(directory: &Path, format: Format) -> Result<CaptureMetadata, ErrorBody> {
    if matches!(format, Format::Heic) {
        let dimensions = heic_dimensions(directory).await?;
        let (mut metadata, _) = capture::image(directory, MAX_INPUT).await;
        metadata.dimensions = dimensions;
        return Ok(metadata);
    }
    let video = format.is_video();
    let info = match probe(directory, format, video).await {
        // Oversized user-controlled tags must not take away an otherwise valid poster.
        Err(error)
            if video
                && error
                    .diagnostic
                    .is_some_and(|d| matches!(d.reason, Reason::OutputLimit)) =>
        {
            probe(directory, format, false).await?
        }
        result => result?,
    };
    let visual = info.visual()?;
    let mut dimensions = visual.dimensions();
    let rotated = visual.rotates();
    let (mut metadata, from_exif) = if video {
        (info.format.tags.metadata(), false)
    } else {
        capture::image(directory, CAPTURE_IMAGE_PREFIX).await
    };
    if let Some(pixels) = &mut dimensions
        && (rotated || from_exif)
    {
        std::mem::swap(&mut pixels.width, &mut pixels.height);
    }
    metadata.dimensions = dimensions;
    Ok(metadata)
}

pub async fn capture(directory: &Path, format: Format) -> Result<CaptureMetadata, ErrorBody> {
    let mut metadata = metadata(directory, format).await?;
    metadata.version = CAPTURE_VERSION;
    Ok(metadata.validated())
}

pub async fn heic_display(directory: &Path) -> Result<Vec<u8>, ErrorBody> {
    let source = source_dimensions(heic_dimensions(directory).await?)?;
    tokio::time::timeout(Duration::from_secs(20), async {
        // Preserve the display quality; try a smaller edge only if the result exceeds the cap.
        let mut last = 0;
        for edge in [DISPLAY_EDGE, 1920, 1280] {
            let edge = edge.min(source.width.max(source.height));
            if edge == last {
                continue;
            }
            last = edge;
            let mut render = Command::new("/usr/bin/vips");
            render.current_dir(directory).args([
                "--vips-concurrency=1",
                "thumbnail",
                "source",
                "display.webp[keep=none,Q=82]",
                &edge.to_string(),
                "--height",
                &edge.to_string(),
                "--size",
                "down",
            ]);
            command(render, 8192, 20, Stage::Encode).await?;
            let mut bytes = Vec::new();
            let file = tokio::fs::File::open(directory.join("display.webp"))
                .await
                .map_err(|_| Failure::Unavailable)?;
            file.take((MAX_DISPLAY_OUTPUT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| Failure::Unavailable)?;
            if bytes.len() > MAX_DISPLAY_OUTPUT {
                continue;
            }
            if display_dimensions(&bytes)
                .is_some_and(|(width, height)| width <= source.width && height <= source.height)
            {
                return Ok(bytes);
            }
            return Err(ErrorBody::diagnostic(
                Failure::InvalidMedia,
                Stage::Encode,
                Reason::InvalidOutput,
            ));
        }
        Err(ErrorBody::diagnostic(
            Failure::ResourceLimit,
            Stage::Encode,
            Reason::OutputLimit,
        ))
    })
    .await
    .map_err(|_| ErrorBody::diagnostic(Failure::Timeout, Stage::Encode, Reason::Deadline))?
}

pub async fn derive(
    directory: &Path,
    format: Format,
) -> Result<(Vec<u8>, CaptureMetadata), ErrorBody> {
    let metadata = capture(directory, format).await?;
    source_dimensions(metadata.dimensions)?;
    let mut encoder = Command::new("/usr/bin/ffmpeg");
    encoder
        .current_dir(directory)
        .args(["-nostdin", "-nostats"]);
    let source = if matches!(format, Format::Heic) {
        // Only a small, inert image enters FFmpeg; keeping the same encoder and validator gives
        // the HEIC path the exact same metadata-free VP8 output contract as every other format.
        let mut resize = Command::new("/usr/bin/vips");
        resize.current_dir(directory).args([
            "--vips-concurrency=1",
            "thumbnail",
            "source",
            "primary.ppm",
            "244",
            "--height",
            "244",
            "--size",
            "down",
        ]);
        command(resize, 8192, 20, Stage::Encode).await?;
        encoder.args([
            "-v",
            "error",
            "-max_alloc",
            "67108864",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            "ppm_pipe",
            "-f",
            "ppm_pipe",
        ]);
        "primary.ppm"
    } else {
        input(&mut encoder, format);
        "source"
    };
    encoder.args([
        "-err_detect",
        "explode",
        "-i",
        source,
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-vf",
        "scale=w='min(244,iw)':h='min(244,ih)':force_original_aspect_ratio=decrease:flags=bilinear,sidedata=mode=delete,setsar=1",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        "-c:v",
        "libwebp",
        "-quality",
        "75",
        "-compression_level",
        "4",
        "-f",
        "webp",
        "pipe:1",
    ]);
    let bytes = command(encoder, MAX_OUTPUT, 20, Stage::Encode).await?;
    webp_dimensions(&bytes).ok_or_else(|| {
        ErrorBody::diagnostic(Failure::InvalidMedia, Stage::Encode, Reason::InvalidOutput)
    })?;
    Ok((bytes, metadata))
}

fn source_dimensions(
    dimensions: Option<CaptureDimensions>,
) -> Result<CaptureDimensions, ErrorBody> {
    let dimensions = dimensions
        .filter(|d| d.width > 0 && d.height > 0)
        .ok_or_else(|| {
            ErrorBody::diagnostic(Failure::InvalidMedia, Stage::Probe, Reason::InvalidProbe)
        })?;
    if u64::from(dimensions.width) * u64::from(dimensions.height) > MAX_PIXELS {
        return Err(ErrorBody::diagnostic(
            Failure::ResourceLimit,
            Stage::Probe,
            Reason::InputLimit,
        ));
    }
    Ok(dimensions)
}

use hyori_media_worker::{Failure, Format, MAX_DURATION, MAX_OUTPUT, MAX_PIXELS, webp_dimensions};
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
async fn command(mut command: Command, cap: usize, seconds: u64) -> Result<Vec<u8>, Failure> {
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
        let (status, output, _) = tokio::try_join!(
            async { child.wait().await.map_err(|_| Failure::Unavailable) },
            limited(stdout, cap),
            limited(stderr, 8192)
        )?;
        if !status.success() {
            return Err(Failure::InvalidMedia);
        }
        Ok(output)
    })
    .await
    .map_err(|_| Failure::Timeout)?
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
    format: ProbeFormat,
}
#[derive(Deserialize)]
struct Stream {
    width: Option<u32>,
    height: Option<u32>,
    codec_type: String,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

pub async fn derive(directory: &Path, format: Format) -> Result<Vec<u8>, Failure> {
    let mut probe = Command::new("/usr/bin/ffprobe");
    probe.current_dir(directory);
    input(&mut probe, format);
    probe.args([
        "-show_entries",
        "stream=width,height,codec_type:format=duration",
        "-of",
        "json",
        "source",
    ]);
    let info: Probe = serde_json::from_slice(&command(probe, 64 * 1024, 10).await?)
        .map_err(|_| Failure::InvalidMedia)?;
    let visual = info
        .streams
        .iter()
        .find(|s| s.codec_type == "video")
        .ok_or(Failure::InvalidMedia)?;
    let (width, height) = visual
        .width
        .zip(visual.height)
        .ok_or(Failure::InvalidMedia)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(Failure::ResourceLimit);
    }
    if format.is_video() {
        let duration = info
            .format
            .duration
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .ok_or(Failure::Unsupported)?;
        if duration > MAX_DURATION {
            return Err(Failure::ResourceLimit);
        }
    }
    let mut encoder = Command::new("/usr/bin/ffmpeg");
    encoder
        .current_dir(directory)
        .args(["-nostdin", "-nostats"]);
    input(&mut encoder, format);
    encoder.args([
        "-err_detect",
        "explode",
        "-i",
        "source",
        "-map",
        "0:v:0",
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
    let bytes = command(encoder, MAX_OUTPUT, 20).await?;
    webp_dimensions(&bytes).ok_or(Failure::InvalidMedia)?;
    Ok(bytes)
}

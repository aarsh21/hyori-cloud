//! The private, versioned media capability protocol. This library never starts a decoder.
//! Worker runtime/decode implementation belongs exclusively to the separate executable.
#![forbid(unsafe_code)]
mod diagnostics;
pub use diagnostics::{Diagnostic, Reason, Stage, rejection_reason};
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/v1/derive";
pub const DECODER_PATH: &str = "/v1/decoder";
pub const CAPTURE_PATH: &str = "/v1/capture";
pub const CAPTURE_HEADER: &str = "x-hyori-capture";
pub const MAX_CAPTURE: usize = 512;
pub const CAPTURE_IMAGE_PREFIX: u64 = 1024 * 1024;
pub const MAX_INPUT: u64 = 64 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 256 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_DURATION: f64 = 120.0;
pub const EDGE: u32 = 384;
pub const RECIPE: i32 = 1;

/// Only normalized fields cross the worker boundary. No raw EXIF/format tags are returned.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
pub struct CaptureMetadata {
    pub time: Option<CaptureTime>,
    pub location: Option<CaptureLocation>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct CaptureTime {
    pub local: chrono::NaiveDateTime,
    pub offset_minutes: Option<i32>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct CaptureLocation {
    pub latitude: f64,
    pub longitude: f64,
}

impl CaptureMetadata {
    pub fn validated(mut self) -> Self {
        use chrono::{Datelike, Timelike};
        self.time = self.time.filter(|time| {
            (1..=9999).contains(&time.local.year()) && time.local.nanosecond() < 1_000_000_000
        });
        if let Some(time) = &mut self.time {
            time.offset_minutes = time.offset_minutes.filter(|v| (-1439..=1439).contains(v));
        }
        self.location = self.location.filter(|point| {
            (-90.0..=90.0).contains(&point.latitude) && (-180.0..=180.0).contains(&point.longitude)
        });
        self
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    Unsupported,
    InvalidMedia,
    ResourceLimit,
    Timeout,
    Busy,
    Unavailable,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: Failure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<Diagnostic>,
}

#[derive(Clone, Copy)]
pub enum Format {
    Jpeg,
    Png,
    Webp,
    Gif,
    Avif,
    Mp4,
    Webm,
    Quicktime,
}
impl Format {
    pub fn from_mime(mime: &str) -> Option<Self> {
        Some(match mime {
            "image/jpeg" => Self::Jpeg,
            "image/png" => Self::Png,
            "image/webp" => Self::Webp,
            "image/gif" => Self::Gif,
            "image/avif" => Self::Avif,
            "video/mp4" => Self::Mp4,
            "video/webm" => Self::Webm,
            "video/quicktime" => Self::Quicktime,
            _ => return None,
        })
    }
    pub fn demuxer(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg_pipe",
            Self::Png => "png_pipe",
            Self::Webp => "webp_pipe",
            Self::Gif => "gif",
            Self::Avif | Self::Mp4 | Self::Quicktime => "mov",
            Self::Webm => "matroska",
        }
    }
    pub fn is_video(self) -> bool {
        matches!(self, Self::Mp4 | Self::Webm | Self::Quicktime)
    }
    pub fn accepts_header(self, b: &[u8]) -> bool {
        match self {
            Self::Jpeg => b.starts_with(b"\xff\xd8\xff"),
            Self::Png => b.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Webp => b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP"),
            Self::Gif => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
            Self::Webm => {
                b.starts_with(b"\x1a\x45\xdf\xa3") && b.windows(7).any(|w| w == b"\x42\x82\x84webm")
            }
            Self::Avif | Self::Mp4 | Self::Quicktime => {
                if b.get(4..8) != Some(b"ftyp") {
                    return false;
                }
                let Some(raw) = b.get(..4).and_then(|v| <[u8; 4]>::try_from(v).ok()) else {
                    return false;
                };
                let len = u32::from_be_bytes(raw) as usize;
                if len < 16 || len > b.len() || !len.is_multiple_of(4) {
                    return false;
                }
                let major = &b[8..12];
                let avif = matches!(major, b"avif" | b"avis")
                    || b[16..len]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .any(|v| matches!(v, b"avif" | b"avis"));
                match self {
                    Self::Avif => avif,
                    Self::Quicktime => !avif && major == b"qt  ",
                    Self::Mp4 => {
                        !avif
                            && matches!(
                                major,
                                b"isom"
                                    | b"iso2"
                                    | b"iso4"
                                    | b"iso5"
                                    | b"iso6"
                                    | b"mp41"
                                    | b"mp42"
                                    | b"avc1"
                                    | b"M4V "
                            )
                    }
                    _ => false,
                }
            }
        }
    }
}
/// Accept only a complete, metadata-free, single lossy WebP key frame. No decoder runs here.
/// The RIFF length, VP8 partition envelope, signature and unscaled geometry are all checked;
/// animation, lossless, extended headers, metadata, additional chunks and trailing bytes are refused.
pub fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > MAX_OUTPUT
        || bytes.len() < 30
        || bytes.get(..4)? != b"RIFF"
        || bytes.get(8..16)? != b"WEBPVP8 "
    {
        return None;
    }
    let riff = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let length = u32::from_le_bytes(bytes[16..20].try_into().ok()?) as usize;
    if riff.checked_add(8)? != bytes.len()
        || length < 10
        || length.checked_add(20)?.checked_add(length % 2)? != bytes.len()
        || (length % 2 == 1 && bytes.last() != Some(&0))
    {
        return None;
    }
    let frame = bytes.get(20..20 + length)?;
    let tag = u32::from_le_bytes([frame[0], frame[1], frame[2], 0]);
    let partition = (tag >> 5) as usize;
    if tag & 1 != 0
        || (tag >> 1) & 7 > 3
        || tag & 16 == 0
        || partition == 0
        || partition > length - 10
        || frame[3..6] != *b"\x9d\x01\x2a"
    {
        return None;
    }
    let width = u32::from(u16::from_le_bytes(frame[6..8].try_into().ok()?));
    let height = u32::from(u16::from_le_bytes(frame[8..10].try_into().ok()?));
    // Reject scaling bits as well as oversized/zero geometry.
    (width > 0 && height > 0 && width <= EDGE && height <= EDGE).then_some((width, height))
}

/// Validate legacy normalized PNG output during a rolling worker upgrade.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > MAX_OUTPUT
        || bytes.len() < 33
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes[8..16] != *b"\0\0\0\rIHDR"
    {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 || width > 256 || height > 256 {
        return None;
    }
    if bytes[24..29] != [8, 2, 0, 0, 0] {
        return None;
    }
    let mut remaining = &bytes[8..];
    let mut image = false;
    let mut first = true;
    while remaining.len() >= 12 {
        let length = u32::from_be_bytes(remaining[..4].try_into().ok()?) as usize;
        let end = length.checked_add(12)?;
        if end > remaining.len() {
            return None;
        }
        let kind = &remaining[4..8];
        match kind {
            b"IHDR" if first && length == 13 => {}
            b"IDAT" if length > 0 => image = true,
            b"pHYs" if length == 9 => {}
            b"IEND" if image && length == 0 && end == remaining.len() => {
                return Some((width, height));
            }
            _ => return None,
        }
        first = false;
        remaining = &remaining[end..];
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &[u8] = include_bytes!("../../server/tests/fixtures/media/red.png");
    const WEBP: &[u8] = include_bytes!("../../server/tests/fixtures/media/red.webp");
    #[test]
    fn normalized_webp_requires_a_complete_single_bounded_key_frame() {
        assert_eq!(webp_dimensions(WEBP), Some((16, 16)));
        for end in 0..WEBP.len() {
            assert_eq!(webp_dimensions(&WEBP[..end]), None);
        }
        for (offset, replacement) in [
            (0, b"RIFX".as_slice()),
            (8, b"WAVE"),
            (12, b"VP8L"),
            (12, b"VP8X"),
            (12, b"ANIM"),
            (16, &u32::MAX.to_le_bytes()),
            (20, &[0xd1]), // Inter-frame, not a still.
            (20, &[0xc0]), // Hidden frame.
            (23, b"bad"),
            (26, &0_u16.to_le_bytes()),
            (26, &385_u16.to_le_bytes()),
            (28, &385_u16.to_le_bytes()),
            (28, &0x4010_u16.to_le_bytes()), // Scaling flag.
        ] {
            let mut invalid = WEBP.to_vec();
            invalid[offset..offset + replacement.len()].copy_from_slice(replacement);
            assert_eq!(webp_dimensions(&invalid), None, "offset {offset}");
        }
        let mut appended = WEBP.to_vec();
        appended.extend_from_slice(b"EXIF\0\0\0\0");
        let riff = (appended.len() - 8) as u32;
        appended[4..8].copy_from_slice(&riff.to_le_bytes());
        assert_eq!(webp_dimensions(&appended), None);
        let mut boundary = WEBP.to_vec();
        boundary[26..28].copy_from_slice(&(EDGE as u16).to_le_bytes());
        assert_eq!(webp_dimensions(&boundary), Some((EDGE, 16)));
    }
    #[test]
    fn normalized_png_has_bounded_complete_geometry() {
        assert_eq!(png_dimensions(PNG), Some((16, 16)));
        assert_eq!(png_dimensions(&PNG[..PNG.len() - 1]), None);
        let mut oversized = PNG.to_vec();
        oversized[16..20].copy_from_slice(&257_u32.to_be_bytes());
        assert_eq!(png_dimensions(&oversized), None);
    }
    #[test]
    fn normalized_output_rejects_metadata_chunks_and_active_documents() {
        let mut tagged = PNG[..33].to_vec();
        tagged.extend_from_slice(b"\0\0\0\0tEXt\0\0\0\0");
        tagged.extend_from_slice(&PNG[33..]);
        assert_eq!(png_dimensions(&tagged), None);
        assert_eq!(png_dimensions(b"<svg><script/></svg>"), None);
        assert!(Format::from_mime("image/svg+xml").is_none());
        assert!(!Format::Png.accepts_header(b"<html/>"));
    }
    #[test]
    fn protocol_errors_do_not_accept_unknown_failure_codes() {
        assert!(serde_json::from_str::<ErrorBody>(r#"{"error":"invented"}"#).is_err());
        assert_eq!(
            serde_json::from_str::<ErrorBody>(r#"{"error":"resourceLimit"}"#)
                .unwrap()
                .error,
            Failure::ResourceLimit
        );
    }
}

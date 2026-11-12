//! The private, versioned media capability protocol. This library never starts a decoder.
//! Worker runtime/decode implementation belongs exclusively to the separate executable.
#![forbid(unsafe_code)]
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/v1/derive";
pub const MAX_INPUT: u64 = 64 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 256 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_DURATION: f64 = 120.0;
pub const EDGE: u32 = 256;
pub const RECIPE: i32 = 1;
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
/// Validate the normalized PNG envelope and bounded geometry before accepting worker output.
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
    if width == 0 || height == 0 || width > EDGE || height > EDGE {
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

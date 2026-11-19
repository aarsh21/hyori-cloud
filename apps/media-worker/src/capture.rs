use chrono::{DateTime, NaiveDateTime};
use exif::{Exif, In, Tag, Value};
use hyori_media_worker::{CAPTURE_IMAGE_PREFIX, CaptureLocation, CaptureMetadata, CaptureTime};
use serde::Deserialize;
use std::{io::Cursor, path::Path};
use tokio::io::AsyncReadExt;

// Bound parser input even for a large original. A tag beyond this prefix is treated as missing.
pub async fn image(directory: &Path) -> CaptureMetadata {
    let Ok(file) = tokio::fs::File::open(directory.join("source")).await else {
        return CaptureMetadata::default();
    };
    let mut bytes = Vec::new();
    if file
        .take(CAPTURE_IMAGE_PREFIX)
        .read_to_end(&mut bytes)
        .await
        .is_err()
    {
        return CaptureMetadata::default();
    }
    // Writers such as piexif omit the next-directory offset in EXIF/GPS subdirectories.
    // Keep fields the parser validated before recoverable errors without reading raw tags ourselves.
    let Ok(exif) = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut Cursor::new(bytes))
        .or_else(|error| error.distill_partial_result(|_| {}))
    else {
        return CaptureMetadata::default();
    };
    let time = ascii(&exif, Tag::DateTimeOriginal)
        .and_then(|date| NaiveDateTime::parse_from_str(date, "%Y:%m:%d %H:%M:%S").ok())
        .map(|local| CaptureTime {
            local,
            offset_minutes: ascii(&exif, Tag::OffsetTimeOriginal).and_then(offset),
        });
    let location = gps_axis(&exif, Tag::GPSLatitude, Tag::GPSLatitudeRef, "N", "S")
        .zip(gps_axis(
            &exif,
            Tag::GPSLongitude,
            Tag::GPSLongitudeRef,
            "E",
            "W",
        ))
        .map(|(latitude, longitude)| CaptureLocation {
            latitude,
            longitude,
        });
    CaptureMetadata { time, location }.validated()
}

fn ascii(exif: &Exif, tag: Tag) -> Option<&str> {
    let Value::Ascii(parts) = &exif.get_field(tag, In::PRIMARY)?.value else {
        return None;
    };
    std::str::from_utf8(parts.first()?).ok().map(str::trim)
}

fn offset(value: &str) -> Option<i32> {
    if value.len() != 6
        || !matches!(value.as_bytes()[0], b'+' | b'-')
        || value.as_bytes()[3] != b':'
    {
        return None;
    }
    let hours: u32 = value.get(1..3)?.parse().ok()?;
    let minutes: u32 = value.get(4..6)?.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    let total = (hours * 60 + minutes) as i32;
    Some(if value.starts_with('-') {
        -total
    } else {
        total
    })
}

fn gps_axis(
    exif: &Exif,
    value: Tag,
    reference: Tag,
    positive: &str,
    negative: &str,
) -> Option<f64> {
    let Value::Rational(values) = &exif.get_field(value, In::PRIMARY)?.value else {
        return None;
    };
    let [degrees, minutes, seconds] = values.as_slice() else {
        return None;
    };
    if values.iter().any(|v| v.denom == 0) || minutes.to_f64() >= 60.0 || seconds.to_f64() >= 60.0 {
        return None;
    }
    let decimal = degrees.to_f64() + minutes.to_f64() / 60.0 + seconds.to_f64() / 3600.0;
    match ascii(exif, reference)? {
        v if v == positive => Some(decimal),
        v if v == negative => Some(-decimal),
        _ => None,
    }
}

#[derive(Default, Deserialize)]
pub struct VideoTags {
    #[serde(rename = "com.apple.quicktime.creationdate")]
    quicktime_date: Option<String>,
    creation_time: Option<String>,
    #[serde(rename = "com.apple.quicktime.location.ISO6709")]
    quicktime_location: Option<String>,
    location: Option<String>,
}

impl VideoTags {
    pub fn normalized(&self) -> CaptureMetadata {
        let time = self
            .quicktime_date
            .as_deref()
            .and_then(video_time)
            .or_else(|| self.creation_time.as_deref().and_then(video_time));
        let location = self
            .quicktime_location
            .as_deref()
            .and_then(iso6709)
            .or_else(|| self.location.as_deref().and_then(iso6709));
        CaptureMetadata { time, location }.validated()
    }
}

fn video_time(value: &str) -> Option<CaptureTime> {
    let value = value.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(value)
        .or_else(|_| DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
    {
        return Some(CaptureTime {
            local: time.naive_local(),
            offset_minutes: Some(time.offset().local_minus_utc() / 60),
        });
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|local| CaptureTime {
            local,
            offset_minutes: None,
        })
}

/// The signed decimal-degree forms FFprobe surfaces from MOV/MP4, with optional altitude.
fn iso6709(value: &str) -> Option<CaptureLocation> {
    let value = value.trim();
    let (latitude, rest) = signed_decimal(value.strip_suffix('/').unwrap_or(value), 2)?;
    let (longitude, rest) = signed_decimal(rest, 3)?;
    // An optional third signed axis is altitude; deliberately do not expose it.
    if !rest.is_empty() && !signed_decimal(rest, 12)?.1.is_empty() {
        return None;
    }
    Some(CaptureLocation {
        latitude,
        longitude,
    })
}

fn signed_decimal(value: &str, max_digits: usize) -> Option<(f64, &str)> {
    if !value.starts_with(['+', '-']) {
        return None;
    }
    let end = value[1..].find(['+', '-']).map_or(value.len(), |i| i + 1);
    let (number, rest) = value.split_at(end);
    let whole = number[1..].split('.').next()?;
    if whole.is_empty()
        || whole.len() > max_digits
        || !number[1..].bytes().all(|b| b.is_ascii_digit() || b == b'.')
    {
        return None;
    }
    Some((number.parse::<f64>().ok().filter(|n| n.is_finite())?, rest))
}

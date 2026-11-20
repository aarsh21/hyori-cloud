use crate::{AppState, db::sql, error::ApiError};
use chrono::{DateTime, Utc};
use hyori_media_worker::{
    CAPTURE_IMAGE_PREFIX, CAPTURE_VERSION, CaptureMetadata, Failure, Format, Reason,
};
use sea_orm::{ConnectionTrait, DbErr};
use std::time::Duration;

/// The persistent item index is also the backfill queue. Claim one current original at a time
/// without holding a database transaction while fetching or probing its bytes.
pub(crate) async fn backfill_next(state: &AppState) -> Result<bool, ApiError> {
    let (Some(worker), Some(storage)) = (&state.media_worker, &state.storage) else {
        return Ok(false);
    };
    if !worker.supports_capture().await {
        return Ok(false);
    }
    let Some(row) = state.db.query_one_raw(sql(
        "WITH candidate AS (
            SELECT i.id FROM hyori_items i JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
            WHERE coalesce(i.photo_probe_due,'-infinity'::timestamptz)<=now()
              AND i.kind='file' AND i.trashed_at IS NULL AND i.object_key IS NOT NULL
              AND (i.photo_probe_due IS NOT NULL OR i.photo_probe_version<2)
              AND ((i.size BETWEEN 1 AND 67108864 AND i.mime_type IN
                    ('image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif'))
                OR (i.size BETWEEN 1 AND 85899345920 AND i.mime_type IN ('video/mp4','video/webm','video/quicktime')))
            ORDER BY coalesce(i.photo_probe_due,'-infinity'::timestamptz),i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED
        ) UPDATE hyori_items i SET photo_probe_due=now()+interval '5 minutes' FROM candidate c WHERE i.id=c.id
        RETURNING i.owner_id,i.object_key,i.mime_type,i.size,i.photo_probe_due", vec![])).await? else {
        return Ok(false);
    };
    let owner: String = row.try_get("", "owner_id")?;
    let key: String = row.try_get("", "object_key")?;
    let mime: String = row.try_get("", "mime_type")?;
    let size = row.try_get::<i64>("", "size")? as u64;
    let lease: DateTime<Utc> = row.try_get("", "photo_probe_due")?;
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        let length = match Format::from_mime(&mime) {
            Some(Format::Jpeg | Format::Png | Format::Webp | Format::Gif) => {
                size.min(CAPTURE_IMAGE_PREFIX)
            }
            _ => size,
        };
        let input = super::jobs::read_source(storage, &key, &mime, size, length).await?;
        worker.capture(&mime, input).await
    })
    .await;
    let capture = match result {
        Ok(Ok(metadata)) => metadata,
        Ok(Err(error))
            if matches!(
                error.error,
                Failure::Unsupported | Failure::InvalidMedia | Failure::ResourceLimit
            ) || (error.error == Failure::Timeout
                && error
                    .diagnostic
                    .is_some_and(|detail| matches!(detail.reason, Reason::Deadline))) =>
        {
            CaptureMetadata {
                version: CAPTURE_VERSION,
                ..Default::default()
            }
        }
        // The persisted lease already gives a restart-safe retry delay. Exit this tick on an
        // outage instead of claiming more files before another thumbnail job gets a turn.
        _ => return Ok(false),
    };
    record(&state.db, &owner, &key, &mime, Some(lease), capture).await?;
    Ok(true)
}

pub(crate) async fn record(
    db: &impl ConnectionTrait,
    owner: &str,
    key: &str,
    mime: &str,
    lease: Option<DateTime<Utc>>,
    capture: CaptureMetadata,
) -> Result<(), DbErr> {
    db.execute_raw(sql(
        "UPDATE hyori_items SET photo_taken_at=coalesce($5,photo_taken_at),
             photo_offset_minutes=CASE WHEN $5::timestamp IS NULL THEN photo_offset_minutes ELSE $6 END,
             photo_latitude=coalesce($7,photo_latitude),photo_longitude=coalesce($8,photo_longitude),
             photo_camera_make=$9,photo_camera_model=$10,photo_width=$11,photo_height=$12,
             photo_probe_due=NULL,photo_probe_version=$13
         WHERE owner_id=$1 AND object_key=$2 AND mime_type=$3 AND trashed_at IS NULL
           AND (photo_probe_due IS NOT NULL OR photo_probe_version<2)
           AND photo_probe_version<=$13 AND ($4::timestamptz IS NULL OR photo_probe_due=$4)
           AND EXISTS (SELECT 1 FROM hyori_users WHERE id=$1 AND status='active')",
        vec![
            owner.into(),
            key.into(),
            mime.into(),
            lease.into(),
            capture.time.map(|v| v.local).into(),
            capture.time.and_then(|v| v.offset_minutes).into(),
            capture.location.map(|v| v.latitude).into(),
            capture.location.map(|v| v.longitude).into(),
            capture.camera.as_ref().and_then(|v| v.make.clone()).into(),
            capture.camera.and_then(|v| v.model).into(),
            capture.dimensions.map(|v| v.width as i32).into(),
            capture.dimensions.map(|v| v.height as i32).into(),
            i32::from(capture.version).into(),
        ],
    ))
    .await?;
    Ok(())
}

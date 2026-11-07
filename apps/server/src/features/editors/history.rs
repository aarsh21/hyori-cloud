//! Automatic history coalescing never mutates an object and never grants permission to publish.
use crate::{
    db::{DomainResult, sql},
    error::ApiError,
    features::{files::db::Item, uploads::db::Upload},
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};

/// Called after fresh publication authorization, before replacing the previous current reference.
pub(crate) async fn checkpoint(
    tx: &DatabaseTransaction,
    upload: &Upload,
    previous: &Item,
) -> DomainResult<bool> {
    if !upload.editor_bound {
        return Ok(true);
    }
    let save = tx
        .query_one_raw(sql(
            "SELECT session_id,save_mode FROM hyori_editor_saves WHERE upload_id=$1",
            vec![upload.id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?;
    if save.try_get::<String>("", "save_mode")? != "automatic" {
        return Ok(true);
    }
    let session: String = save.try_get("", "session_id")?;
    let row = tx.query_one_raw(sql(
        "SELECT last_auto_upload_id,last_auto_revision,checkpoint_at<=now() AND checkpoint_at>now()-interval '60 seconds' AS inside_window FROM hyori_editor_sessions WHERE id=$1 FOR UPDATE",
        vec![session.clone().into()],
    )).await?.ok_or_else(ApiError::not_found)?;
    let last: Option<String> = row.try_get("", "last_auto_upload_id")?;
    let same_revision =
        row.try_get::<Option<i64>>("", "last_auto_revision")? == Some(previous.revision);
    let inside_window = row.try_get::<Option<bool>>("", "inside_window")? == Some(true);
    let key = previous
        .object_key
        .as_deref()
        .ok_or_else(ApiError::conflict)?;
    if let Some(last) = last.filter(|_| same_revision && inside_window) {
        let provenance = tx.query_one_raw(sql(
            "SELECT u.id FROM hyori_uploads u JOIN hyori_editor_saves s ON s.upload_id=u.id WHERE u.id=$1 AND u.state='complete' AND NOT u.editor_superseded AND u.object_key=$2 AND u.file_id=$3 AND u.uploader_id IS NOT DISTINCT FROM $4 AND s.session_id=$5 AND s.save_mode='automatic' AND s.intent='replace' AND (s.result->>'revision')::bigint=$6 FOR UPDATE OF u",
            vec![last.clone().into(),key.into(),previous.id.clone().into(),previous.uploaded_by.clone().into(),session.clone().into(),previous.revision.into()],
        )).await?.is_some();
        if provenance
            && !referenced(
                tx,
                key,
                &previous.id,
                previous.revision,
                Some(&previous.id),
                Some(&upload.id),
                Some(&session),
            )
            .await?
        {
            // The old immutable key becomes an exact-key tombstone in this publication transaction.
            // Fence a previously claimed normal cleanup so it cannot certify the new deletion state.
            tx.execute_raw(sql(
                "UPDATE hyori_uploads SET editor_superseded=true,cleanup_due=now(),cleanup_token=NULL,cleanup_until=NULL WHERE id=$1",
                vec![last.into()],
            )).await?;
            return Ok(false);
        }
    }
    tx.execute_raw(sql(
        "UPDATE hyori_editor_sessions SET checkpoint_at=now() WHERE id=$1",
        vec![session.into()],
    ))
    .await?;
    Ok(true)
}

/// No API can resurrect an unreferenced key: restores require a retained version and uploads
/// always allocate new keys. Pending consumers are nevertheless protected at mark/claim/ack.
async fn referenced(
    tx: &DatabaseTransaction,
    key: &str,
    file: &str,
    revision: i64,
    current_item: Option<&str>,
    publishing_upload: Option<&str>,
    publishing_session: Option<&str>,
) -> DomainResult<bool> {
    let row = tx.query_one_raw(sql(
        "SELECT EXISTS(SELECT 1 FROM hyori_items WHERE object_key=$1 AND id IS DISTINCT FROM $4) OR EXISTS(SELECT 1 FROM hyori_versions WHERE object_key=$1) OR EXISTS(SELECT 1 FROM hyori_media_jobs WHERE source_key=$1 AND state IN ('queued','processing')) OR EXISTS(SELECT 1 FROM hyori_uploads WHERE replace_id=$2 AND replace_revision=$3 AND state NOT IN ('complete','aborted') AND id IS DISTINCT FROM $5) OR EXISTS(SELECT 1 FROM hyori_editor_sessions WHERE file_id=$2 AND revision=$3 AND expires_at>now() AND id IS DISTINCT FROM $6) AS referenced",
        vec![key.into(),file.into(),revision.into(),current_item.into(),publishing_upload.into(),publishing_session.into()],
    )).await?.ok_or_else(ApiError::unavailable)?;
    Ok(row.try_get("", "referenced")?)
}

pub(crate) async fn collectible(tx: &DatabaseTransaction, upload: &Upload) -> DomainResult<bool> {
    let file = upload
        .file_id
        .as_deref()
        .ok_or_else(ApiError::unavailable)?;
    // The revision this upload published: a new file starts at 0 (permanent deletion also
    // tombstones those), a replacement follows the revision it replaced.
    let revision = upload
        .replace_revision
        .map_or(Some(0), |r| r.checked_add(1))
        .ok_or_else(ApiError::unavailable)?;
    Ok(!referenced(tx, &upload.object_key, file, revision, None, None, None).await?)
}

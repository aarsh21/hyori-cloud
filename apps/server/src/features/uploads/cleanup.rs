//! Fair, bounded, restart-safe exact-key reconciliation. Terminal inventory is never discarded.
use crate::{
    AppState,
    auth::random_token,
    db::{self, sql},
    error::ApiError,
    features::{
        editors::history,
        uploads::{db::Upload, service::storage_error},
    },
};
use futures_util::{StreamExt, stream};
use sea_orm::ConnectionTrait;
use std::{sync::Arc, time::Duration};

/// Claim at most eight due keys, with at most four storage reconciliations in flight.
/// Network effects run only after claim/expiry/reservation transactions have committed.
pub async fn reclaim(state: &Arc<AppState>) -> Result<usize, ApiError> {
    reclaim_scope(state, None, false).await
}
/// Give newly superseded objects a bounded priority pass, without starving other cleanup.
pub(crate) async fn reclaim_editors(state: &Arc<AppState>) -> Result<usize, ApiError> {
    reclaim_scope(state, None, true).await
}
pub(crate) async fn reclaim_for_account(
    state: &Arc<AppState>,
    user: &str,
) -> Result<usize, ApiError> {
    reclaim_scope(state, Some(user), false).await
}
async fn reclaim_scope(
    state: &Arc<AppState>,
    user: Option<&str>,
    editors: bool,
) -> Result<usize, ApiError> {
    let Some(storage) = state.storage.as_ref() else {
        return Ok(0);
    };
    let token = random_token();
    let uploads = db::domain(&state.db,|tx| { let token=token.clone(); let user=user.map(str::to_owned); Box::pin(async move {
        let rows = tx.query_all_raw(sql("SELECT * FROM hyori_uploads u WHERE cleanup_due<=now() AND (cleanup_until IS NULL OR cleanup_until<=now()) AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM hyori_account_purge_uploads p WHERE p.user_id=$1 AND p.upload_id=u.id)) AND (NOT $2 OR (editor_superseded AND editor_reclaimed_at IS NULL)) ORDER BY cleanup_due,id LIMIT 8 FOR UPDATE SKIP LOCKED",vec![user.into(),editors.into()])).await?;
        let mut uploads=Vec::new();
        for row in rows {
            let upload=Upload::from_row(row)?;
            // Starting means begin's reply may never have reached the process/client.
            if upload.state == "starting" || (!matches!(upload.state.as_str(),"complete"|"aborted") && upload.expires_at<=chrono::Utc::now()) { upload.abort(tx).await?; }
            let upload=Upload::get(tx,&upload.id).await?;
            if !matches!(upload.state.as_str(),"complete"|"aborted") {
                tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_due=expires_at WHERE id=$1",vec![upload.id.into()])).await?;
                continue;
            }
            if upload.state == "complete" && upload.editor_superseded {
                let active = tx.query_one_raw(sql("SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",vec![upload.owner_id.clone().into()])).await?.is_some();
                if !active || !history::collectible(tx,&upload).await? {
                    tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_due=now()+interval '1 minute' WHERE id=$1",vec![upload.id.into()])).await?;
                    continue;
                }
            }
            tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_token=$2,cleanup_until=now()+interval '5 minutes',cleanup_due=now()+interval '1 minute' WHERE id=$1",vec![upload.id.clone().into(),token.clone().into()])).await?;
            uploads.push(upload);
        }
        Ok(uploads)
    }) }).await?;
    let count = uploads.len();
    let results = stream::iter(uploads)
        .map(|upload| reconcile_storage(storage, upload))
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await;
    let mut failure = None;
    // Parallel quota acknowledgements for one owner conflict with their own serializable snapshots.
    // Keep storage concurrent, but settle this bounded batch without intra-batch database races.
    for result in results {
        if let Err(error) = acknowledge(state, &token, result).await {
            failure.get_or_insert(error);
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(count),
    }
}
struct StorageReconciliation {
    upload: Upload,
    checked: bool,
    delay: i64,
}
async fn reconcile_storage(
    storage: &hyori_storage::ObjectStorage,
    upload: Upload,
) -> StorageReconciliation {
    let deleting = upload.state == "aborted" || upload.editor_superseded;
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        if let Some(id) = upload.multipart_id.as_deref() {
            storage.abort(&upload.object_key, id).await?;
        }
        let page = storage.abort_unfinished(&upload.object_key, None).await?;
        if deleting {
            storage.remove(&upload.object_key).await?;
        }
        Ok::<_, hyori_storage::StorageError>(page.pending)
    })
    .await;
    let checked = matches!(&result, Ok(Ok(false))) && deleting;
    let delay = match result {
        Ok(Ok(false)) => 3600_i64,
        Ok(Ok(true)) => 60,
        Ok(Err(error)) => {
            let _ = storage_error(error);
            tracing::warn!("upload reconciliation failed; durable inventory retained");
            60
        }
        Err(_) => {
            tracing::warn!("upload reconciliation timed out; durable inventory retained");
            60
        }
    };
    StorageReconciliation {
        upload,
        checked,
        delay,
    }
}
async fn acknowledge(
    state: &Arc<AppState>,
    token: &str,
    result: StorageReconciliation,
) -> Result<(), ApiError> {
    let StorageReconciliation {
        upload,
        checked,
        delay,
    } = result;
    db::domain(&state.db, |tx| {
        let (id,token) = (upload.id.clone(),token.to_owned());
        Box::pin(async move {
            let Some(row) = tx.query_one_raw(sql("SELECT * FROM hyori_uploads WHERE id=$1 AND cleanup_token=$2 FOR UPDATE",vec![id.clone().into(),token.clone().into()])).await? else { return Ok(()); };
            let current = Upload::from_row(row)?;
            let mut reclaimed = false;
            if checked && current.state == "complete" && current.editor_superseded {
                // Account purge owns deleting accounts' accounting. A stale cleanup token cannot
                // acknowledge its newly aborted/redacted record or decrement quota twice.
                let active = tx.query_one_raw(sql("SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",vec![current.owner_id.clone().into()])).await?.is_some();
                if active && history::collectible(tx,&current).await? {
                    if let Some(object) = tx.query_one_raw(sql("DELETE FROM hyori_objects WHERE object_key=$1 AND owner_id=$2 RETURNING size",vec![current.object_key.into(),current.owner_id.clone().into()])).await? {
                        tx.execute_raw(sql("UPDATE hyori_users SET used_bytes=used_bytes-$2 WHERE id=$1",vec![current.owner_id.into(),object.try_get::<i64>("","size")?.into()])).await?;
                    }
                    reclaimed = true;
                }
            }
            tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_due=now()+$3::bigint*interval '1 second',cleanup_token=NULL,cleanup_until=NULL,editor_reclaimed_at=CASE WHEN $5 THEN now() ELSE editor_reclaimed_at END,purge_checked_at=CASE WHEN $4 AND state='aborted' THEN now() WHEN purged AND state='aborted' THEN NULL ELSE purge_checked_at END WHERE id=$1 AND cleanup_token=$2",vec![id.into(),token.into(),delay.into(),checked.into(),reclaimed.into()])).await?;
            Ok(())
        })
    }).await
}

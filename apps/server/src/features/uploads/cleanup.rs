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

/// Keys claimed per pass.
pub const BATCH: usize = 8;
/// Partition every row (see migration 0012's partial indexes): never checked clean, or superseded
/// and awaiting reclamation, versus a clean terminal record being revisited for late writes.
const URGENT: &str = "(clean_checks=0 OR (editor_superseded AND editor_reclaimed_at IS NULL))";
const REVISIT: &str =
    "(clean_checks>0 AND NOT (editor_superseded AND editor_reclaimed_at IS NULL))";
/// First revisit of a clean terminal key after an hour, doubling to a 30-day ceiling: late
/// storage effects are still caught, and a row costs O(log) visits rather than one an hour.
pub(crate) fn revisit_seconds(clean_checks: i32) -> i64 {
    backoff(3600, clean_checks, 30 * 24 * 3600)
}
/// A superseded object still referenced elsewhere: a minute, doubling to a day.
fn deferral_seconds(checks: i32) -> i64 {
    backoff(60, checks, 24 * 3600)
}
pub(crate) fn backoff(base: i64, checks: i32, ceiling: i64) -> i64 {
    base.saturating_mul(1_i64 << checks.clamp(0, 32))
        .min(ceiling)
}

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
        // Urgent work first: stale intents, expired reservations, unverified deletes and
        // superseded objects. Clean terminal revisits only fill what is left of the batch.
        let mut rows = Vec::new();
        for class in [URGENT, REVISIT] {
            let limit = (BATCH - rows.len()) as i64;
            if limit == 0 { break; }
            rows.extend(tx.query_all_raw(sql(&format!("SELECT * FROM hyori_uploads u WHERE {class} AND cleanup_due<=now() AND (cleanup_until IS NULL OR cleanup_until<=now()) AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM hyori_account_purge_uploads p WHERE p.user_id=$1 AND p.upload_id=u.id)) AND (NOT $2 OR (editor_superseded AND editor_reclaimed_at IS NULL)) ORDER BY cleanup_due,id LIMIT $3 FOR UPDATE SKIP LOCKED"),vec![user.clone().into(),editors.into(),limit.into()])).await?);
        }
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
                    // Still referenced (history, a queued thumbnail, an open session): wait
                    // longer each time instead of rechecking every minute indefinitely.
                    tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_due=now()+$2::bigint*interval '1 second',clean_checks=clean_checks+1 WHERE id=$1",vec![upload.id.into(),deferral_seconds(upload.clean_checks).into()])).await?;
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
    outcome: Outcome,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Clean,
    Pending,
    Failed,
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
    let outcome = match result {
        Ok(Ok(false)) => Outcome::Clean,
        Ok(Ok(true)) => Outcome::Pending,
        Ok(Err(error)) => {
            let _ = storage_error(error);
            tracing::warn!("upload reconciliation failed; durable inventory retained");
            Outcome::Failed
        }
        Err(_) => {
            tracing::warn!("upload reconciliation timed out; durable inventory retained");
            Outcome::Failed
        }
    };
    StorageReconciliation {
        upload,
        checked,
        outcome,
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
        outcome,
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
            // Clean observations back off; remaining multipart work becomes urgent again; a
            // failure retries soon without forgetting how many clean checks preceded it.
            let (delay, checks) = match outcome {
                Outcome::Clean => (revisit_seconds(current.clean_checks), current.clean_checks.saturating_add(1)),
                Outcome::Pending => (60, 0),
                Outcome::Failed => (60, current.clean_checks),
            };
            tx.execute_raw(sql("UPDATE hyori_uploads SET cleanup_due=now()+$3::bigint*interval '1 second',clean_checks=$6,cleanup_token=NULL,cleanup_until=NULL,editor_reclaimed_at=CASE WHEN $5 THEN now() ELSE editor_reclaimed_at END,purge_checked_at=CASE WHEN $4 AND state='aborted' THEN now() WHEN purged AND state='aborted' THEN NULL ELSE purge_checked_at END WHERE id=$1 AND cleanup_token=$2",vec![id.into(),token.into(),delay.into(),checked.into(),reclaimed.into(),checks.into()])).await?;
            Ok(())
        })
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_revisits_double_from_an_hour_to_a_thirty_day_ceiling() {
        let delays: Vec<_> = (0..12).map(revisit_seconds).collect();
        assert_eq!(&delays[..4], [3600, 7200, 14_400, 28_800]);
        assert!(delays.windows(2).all(|pair| pair[1] >= pair[0]));
        assert_eq!(delays[11], 30 * 24 * 3600);
        assert_eq!(revisit_seconds(i32::MAX), 30 * 24 * 3600);
        assert_eq!(revisit_seconds(-1), 3600);
    }
    #[test]
    fn a_clean_key_costs_logarithmic_visits_over_a_year() {
        let (mut elapsed, mut visits) = (0_i64, 0);
        while elapsed < 365 * 24 * 3600 {
            elapsed += revisit_seconds(visits);
            visits += 1;
        }
        // Hourly revisits cost 8,760 visits a year; backoff needs about twenty.
        assert!(visits <= 22, "{visits}");
    }
    #[test]
    fn referenced_superseded_objects_wait_at_most_a_day() {
        assert_eq!(deferral_seconds(0), 60);
        assert_eq!(deferral_seconds(40), 24 * 3600);
    }
}

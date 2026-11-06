use crate::{
    AppState,
    auth::random_token,
    db::{self, sql},
    error::ApiError,
};
use sea_orm::ConnectionTrait;
use std::{sync::Arc, time::Duration};

/// Reconcile at most eight retained derivative keys. This also runs when the decoder is disabled.
pub async fn reclaim(state: &Arc<AppState>) -> Result<usize, ApiError> {
    reclaim_scope(state, None).await
}
pub(crate) async fn reclaim_owner(state: &Arc<AppState>, owner: &str) -> Result<usize, ApiError> {
    reclaim_scope(state, Some(owner)).await
}
async fn reclaim_scope(state: &Arc<AppState>, owner: Option<&str>) -> Result<usize, ApiError> {
    let Some(storage) = state.storage.as_ref() else {
        return Ok(0);
    };
    let token = random_token();
    let records=db::domain(&state.db,|tx|{let token=token.clone();let owner=owner.map(str::to_owned);Box::pin(async move{
        let rows=tx.query_all_raw(sql("SELECT a.*,coalesce(u.status='active',false) AS active FROM hyori_media_artifacts a LEFT JOIN hyori_users u ON u.id=a.owner_id
            WHERE cleanup_due<=now() AND (cleanup_until IS NULL OR cleanup_until<=now()) AND ($1::text IS NULL OR a.owner_id=$1)
            ORDER BY cleanup_due,a.id LIMIT 8 FOR UPDATE OF a SKIP LOCKED",vec![owner.into()])).await?;
        let mut records=Vec::new();
        for row in rows{
            let id:String=row.try_get("","id")?;
            let state:String=row.try_get("","state")?;
            let active:bool=row.try_get("","active")?;
            let aborted=!active || state!="ready";
            // Starting intents first become due after ten minutes, beyond all processing deadlines.
            tx.execute_raw(sql("UPDATE hyori_media_artifacts SET state=CASE WHEN $3 THEN 'aborted' ELSE state END,
                cleanup_token=$2,cleanup_until=now()+interval '5 minutes',cleanup_due=now()+interval '1 minute' WHERE id=$1",vec![id.clone().into(),token.clone().into(),aborted.into()])).await?;
            records.push((id,row.try_get::<String>("","object_key")?,row.try_get::<Option<String>>("","multipart_id")?,aborted,row.try_get::<Option<i64>>("","size")?));
        }
        Ok(records)
    })}).await?;
    let count = records.len();
    for (id, key, multipart, aborted, expected_size) in records {
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            if let Some(multipart) = multipart {
                storage.abort(&key, &multipart).await?;
            }
            let pending = storage.abort_unfinished(&key, None).await?.pending;
            let missing = if aborted {
                storage.remove(&key).await?;
                false
            } else {
                match storage.head(&key).await {
                    Ok(head) => Some(head.size as i64) != expected_size,
                    Err(hyori_storage::StorageError::Service {
                        status: Some(404), ..
                    }) => true,
                    Err(error) => return Err(error),
                }
            };
            Ok::<_, hyori_storage::StorageError>((pending, missing))
        })
        .await;
        let missing = matches!(result, Ok(Ok((_, true))));
        let clean = matches!(result, Ok(Ok((false, false))));
        db::domain(&state.db,|tx|{let(id,token)=(id.clone(),token.clone());Box::pin(async move {
            let delay=if missing {0_i64} else if clean {3600} else {60};
            let changed=tx.execute_raw(sql("UPDATE hyori_media_artifacts SET cleanup_token=NULL,cleanup_until=NULL,
                state=CASE WHEN $5 THEN 'aborted' ELSE state END,cleanup_due=now()+$3::bigint*interval '1 second',checked_at=CASE WHEN $4 THEN now() ELSE NULL END
                WHERE id=$1 AND cleanup_token=$2",vec![id.clone().into(),token.into(),delay.into(),clean.into(),missing.into()])).await?;
            if missing && changed.rows_affected()==1 {
                // Only observed absence/length corruption triggers bounded repair, never a storage outage.
                tx.execute_raw(sql("UPDATE hyori_media_jobs SET state=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
                    artifact_id=NULL,failure='unavailable',due_at=now(),lease_token=NULL,lease_until=NULL
                    WHERE artifact_id=$1 AND state='ready'",vec![id.into()])).await?;
            }
            Ok(())
        })}).await?;
    }
    Ok(count)
}

pub(crate) async fn prepare_purge(
    tx: &sea_orm::DatabaseTransaction,
    user: &str,
) -> db::DomainResult<()> {
    // Leave an in-flight worker's lease visible until it exits or its bounded deadline expires.
    tx.execute_raw(sql("DELETE FROM hyori_media_jobs WHERE id IN (SELECT id FROM hyori_media_jobs WHERE owner_id=$1 AND (state<>'processing' OR lease_until<=now()) ORDER BY id LIMIT 256)",vec![user.into()])).await?;
    tx.execute_raw(sql("UPDATE hyori_media_artifacts SET state='aborted',job_id='',size=NULL,width=NULL,height=NULL,checked_at=NULL,
        cleanup_token=NULL,cleanup_until=NULL,cleanup_due=now() WHERE id IN
        (SELECT id FROM hyori_media_artifacts WHERE owner_id=$1 AND (state<>'aborted' OR job_id<>'') ORDER BY id LIMIT 256)",vec![user.into()])).await?;
    Ok(())
}
pub(crate) async fn purge_pending(
    tx: &sea_orm::DatabaseTransaction,
    user: &str,
) -> db::DomainResult<bool> {
    let row=tx.query_one_raw(sql("SELECT EXISTS(SELECT 1 FROM hyori_media_jobs WHERE owner_id=$1) OR
        EXISTS(SELECT 1 FROM hyori_media_artifacts a JOIN hyori_account_purges p ON p.user_id=a.owner_id
        WHERE a.owner_id=$1 AND (a.state<>'aborted' OR a.job_id<>'' OR a.checked_at IS NULL OR a.checked_at<p.created_at)) AS pending",vec![user.into()])).await?.ok_or_else(ApiError::unavailable)?;
    Ok(row.try_get("", "pending")?)
}

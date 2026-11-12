//! Server-owned account cleanup. Minimal account/key tombstones remain indefinitely for late work.
use crate::{
    AppState,
    auth::random_token,
    db::{self, sql},
    error::ApiError,
    features::{
        admin::{
            api::{PurgeResult, PurgeState},
            purge_db,
        },
        auth::api::{Bytes, Id},
        uploads::cleanup,
    },
};
use sea_orm::ConnectionTrait;
use std::{sync::Arc, time::Duration};

pub(crate) async fn progress(state: &Arc<AppState>, user: Id) -> Result<PurgeResult, ApiError> {
    let row = state.db.query_one_raw(sql("SELECT completed_at IS NOT NULL AS complete,deleted_objects FROM hyori_account_purges WHERE user_id=$1",vec![user.0.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
    Ok(PurgeResult {
        user_id: user,
        state: if row.try_get::<bool>("", "complete")? {
            PurgeState::Complete
        } else {
            PurgeState::Pending
        },
        deleted_objects: Bytes(row.try_get::<i64>("", "deleted_objects")? as u64),
    })
}
/// At most two accounts, independently leased and ordered by durable due time.
pub async fn reclaim(state: &Arc<AppState>) -> Result<usize, ApiError> {
    let token = random_token();
    let users = db::domain(&state.db, |tx| { let token=token.clone(); Box::pin(async move {
        let rows = tx.query_all_raw(sql("SELECT p.user_id FROM hyori_account_purges p JOIN hyori_users u ON u.id=p.user_id
            WHERE u.status IN ('deleting','deleted') AND p.due_at<=now() AND (p.lease_until IS NULL OR p.lease_until<=now())
            ORDER BY p.due_at,p.user_id LIMIT 2 FOR UPDATE OF p SKIP LOCKED",vec![])).await?;
        let ids = rows.iter().map(|row| row.try_get::<String>("", "user_id")).collect::<Result<Vec<_>,_>>()?;
        tx.execute_raw(sql("UPDATE hyori_account_purges SET lease_token=$2,lease_until=now()+interval '5 minutes',due_at=now()+interval '1 minute' WHERE user_id IN (SELECT jsonb_array_elements_text($1::jsonb))",vec![serde_json::json!(ids).into(),token.into()])).await?;
        Ok(ids)
    }) }).await?;
    let count = users.len();
    for user in users {
        if let Err(error) = pass(state, &user, &token).await {
            tracing::warn!(%error,"account cleanup failed; retained inventory will be retried");
            state.db.execute_raw(sql("UPDATE hyori_account_purges SET lease_token=NULL,lease_until=NULL,due_at=now()+interval '1 minute' WHERE user_id=$1 AND lease_token=$2",vec![user.into(),token.clone().into()])).await?;
        }
    }
    Ok(count)
}
async fn pass(state: &Arc<AppState>, user: &str, token: &str) -> Result<(), ApiError> {
    db::domain(&state.db, |tx| { let user=user.to_owned(); let token=token.to_owned(); Box::pin(async move {
        if tx.query_one_raw(sql("SELECT user_id FROM hyori_account_purges WHERE user_id=$1 AND lease_token=$2 FOR UPDATE",vec![user.as_str().into(),token.as_str().into()])).await?.is_none() { return Err(ApiError::conflict().into()); }
        purge_db::prepare(tx,&user).await
    }) }).await?;
    let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        cleanup::reclaim_for_account(state, user).await?;
        crate::features::media::cleanup::reclaim_owner(state, user).await?;
        storage
            .purge_owner_objects(user)
            .await
            .map_err(crate::features::uploads::service::storage_error)
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    db::domain(&state.db, |tx| { let user=user.to_owned(); let token=token.to_owned(); Box::pin(async move {
        if tx.query_one_raw(sql("SELECT user_id FROM hyori_account_purges WHERE user_id=$1 AND lease_token=$2 FOR UPDATE",vec![user.as_str().into(),token.as_str().into()])).await?.is_none() { return Err(ApiError::conflict().into()); }
        let storage_empty = !result.pending && result.deleted == 0;
        let deleted = if storage_empty {
            tx.execute_raw(sql("DELETE FROM hyori_objects WHERE object_key IN (SELECT object_key FROM hyori_objects WHERE owner_id=$1 ORDER BY object_key LIMIT 256)",vec![user.as_str().into()])).await?.rows_affected()
        } else { 0 };
        let objects = tx.query_one_raw(sql("SELECT EXISTS(SELECT 1 FROM hyori_objects WHERE owner_id=$1) AS present",vec![user.as_str().into()])).await?.ok_or_else(ApiError::unavailable)?.try_get::<bool>("", "present")?;
        let complete = storage_empty && !objects && !purge_db::pending(tx,&user).await?;
        if complete {
            // Preserve the opaque identity/FKs and permanent bootstrap state, but no registrable PII.
            tx.execute_raw(sql("UPDATE hyori_users SET status='deleted',email='deleted:'||id,name='Deleted account',quota_bytes=0,used_bytes=0,reserved_bytes=0,updated_at=now() WHERE id=$1 AND status='deleting'",vec![user.as_str().into()])).await?;
        }
        tx.execute_raw(sql("UPDATE hyori_account_purges SET lease_token=NULL,lease_until=NULL,
            due_at=now()+$3::bigint*interval '1 second',completed_at=CASE WHEN $4 THEN coalesce(completed_at,now()) ELSE completed_at END,
            deleted_objects=deleted_objects+$5 WHERE user_id=$1 AND lease_token=$2",vec![user.as_str().into(),token.as_str().into(),(if complete {3600_i64} else {1_i64}).into(),complete.into(),(deleted as i64).into()])).await?;
        Ok(())
    }) }).await
}

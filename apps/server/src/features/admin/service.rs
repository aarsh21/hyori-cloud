use crate::{
    AppState,
    auth::project_user,
    db::{self, sql},
    error::ApiError,
    features::{
        admin::{api::*, purge},
        auth::api::{Bytes, User},
        files::policy::cursor,
    },
    rpc::RequestContext,
    wire::Nullable,
};
use sea_orm::ConnectionTrait;
use std::sync::Arc;

pub(crate) struct AdminService {
    state: Arc<AppState>,
    context: RequestContext,
}
impl AdminService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            state: state.clone(),
            context,
        }
    }
    pub async fn users(&self, input: UsersInput) -> Result<UsersList, ApiError> {
        let after = cursor(input.cursor.as_ref().and_then(|value| value.0.as_deref()))?;
        db::domain(&self.state.db, |tx| { let state=self.state.clone(); let session=self.context.session.clone(); let after=after.to_owned(); Box::pin(async move {
            state.auth.require_admin(tx, session.as_deref()).await?;
            let rows = tx.query_all_raw(sql("SELECT * FROM hyori_users WHERE status<>'deleted' AND id>$1 ORDER BY id LIMIT 101", vec![after.into()])).await?;
            let next_cursor = if rows.len() > 100 { Some(rows[99].try_get("", "id")?) } else { None };
            let items = rows.iter().take(100).map(|row| {
                Ok(AdminUser { user: project_user(row)?, status: if row.try_get::<String>("", "status")? == "active" { AccountStatus::Active } else { AccountStatus::Deleting }, reserved_bytes: Bytes(row.try_get::<i64>("", "reserved_bytes")? as u64) })
            }).collect::<db::DomainResult<Vec<_>>>()?;
            Ok(UsersList { items, next_cursor: Nullable(next_cursor) })
        }) }).await
    }
    pub async fn set_quota(&self, input: SetQuota) -> Result<User, ApiError> {
        if input.quota_bytes.0 > 9_007_199_254_740_991 {
            return Err(ApiError::invalid());
        }
        db::domain(&self.state.db, |tx| { let input = input.clone(); let state=self.state.clone(); let session=self.context.session.clone(); Box::pin(async move {
            state.auth.require_admin(tx, session.as_deref()).await?;
            let row = tx.query_one_raw(sql("SELECT status FROM hyori_users WHERE id=$1 FOR NO KEY UPDATE", vec![input.user_id.0.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
            if row.try_get::<String>("", "status")? != "active" { return Err(ApiError::conflict().into()); }
            let row = tx.query_one_raw(sql("UPDATE hyori_users SET quota_bytes=$2,updated_at=now() WHERE id=$1 RETURNING *", vec![input.user_id.0.into(),(input.quota_bytes.0 as i64).into()])).await?.ok_or_else(ApiError::not_found)?;
            Ok(project_user(&row)?)
        }) }).await
    }
    pub async fn delete_user(&self, input: DeleteUser) -> Result<PurgeResult, ApiError> {
        db::domain(&self.state.db, |tx| { let input = input.clone(); let state=self.state.clone(); let session=self.context.session.clone(); Box::pin(async move {
            let admin = state.auth.require_admin(tx, session.as_deref()).await?;
            let row = tx.query_one_raw(sql("SELECT u.*,EXISTS(SELECT 1 FROM hyori_bootstrap b WHERE b.admin_id=u.id) AS bootstrap FROM hyori_users u WHERE u.id=$1 FOR UPDATE", vec![input.user_id.0.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
            if input.user_id == *admin.user_id() || row.try_get::<String>("", "role")? == "admin" || row.try_get::<bool>("", "bootstrap")? { return Err(ApiError::denied().into()); }
            if row.try_get::<String>("", "status")? == "deleted" { return Err(ApiError::not_found().into()); }
            if row.try_get::<String>("", "email")? != input.confirm_email { return Err(ApiError::invalid().into()); }
            // Active-status row locks fence both authenticated initiators and destination owners.
            tx.execute_raw(sql("UPDATE hyori_users SET status='deleting',updated_at=now() WHERE id=$1",vec![input.user_id.0.clone().into()])).await?;
            tx.execute_raw(sql("DELETE FROM hyori_credentials WHERE user_id=$1",vec![input.user_id.0.clone().into()])).await?;
            tx.execute_raw(sql("INSERT INTO hyori_account_purges(user_id) VALUES ($1) ON CONFLICT DO NOTHING",vec![input.user_id.0.into()])).await?;
            Ok(())
        }) }).await?;
        // One bounded attempt is useful to small accounts, but continuation belongs to maintenance.
        if let Err(error) = purge::reclaim_user(&self.state, &input.user_id.0).await {
            tracing::warn!(%error,"account purge remains pending; durable maintenance will retry");
        }
        purge::progress(&self.state, input.user_id).await
    }
}

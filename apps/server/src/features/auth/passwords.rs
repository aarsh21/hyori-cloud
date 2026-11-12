use super::{
    api::{Done, Id},
    password_api::{
        ChangePassword, CreatePasswordReset, PasswordResetLink, PasswordResetResult, ResetPassword,
    },
};
use crate::{
    AppState,
    auth::{digest, random_token},
    db::{begin, sql},
    error::ApiError,
    rpc::RequestContext,
};
use sea_orm::ConnectionTrait;

pub struct PasswordService<'a> {
    state: &'a AppState,
}
impl<'a> PasswordService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub async fn change(
        &self,
        context: &RequestContext,
        input: ChangePassword,
    ) -> Result<Done, ApiError> {
        let preflight = begin(&self.state.db).await?;
        let actor = self
            .state
            .auth
            .require_actor(&preflight, context.session.as_deref())
            .await?;
        let user_id = actor.user_id().0.clone();
        let row = preflight
            .query_one_raw(sql(
                "SELECT password_hash FROM hyori_credentials WHERE user_id=$1",
                vec![user_id.clone().into()],
            ))
            .await?
            .ok_or_else(ApiError::required)?;
        let old: String = row.try_get("", "password_hash")?;
        preflight.commit().await?;
        self.state
            .auth
            .rate_limit(
                &self.state.db,
                &format!("password-change:{user_id}"),
                crate::auth::SECRET_ATTEMPTS,
            )
            .await?;
        if !self
            .state
            .auth
            .verify_account_password(&old, &input.current_password)
            .await?
        {
            return Err(ApiError::credentials());
        }
        let hash = self
            .state
            .auth
            .hash_account_password(&input.new_password)
            .await?;
        let tx = begin(&self.state.db).await?;
        tx.query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
            vec![user_id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::required)?;
        // Fence deletion without blocking quota writes held by authenticated work in other sessions.
        // Serialize credential mutations before acquiring session locks. KDF work holds no DB locks.
        let row = tx
            .query_one_raw(sql(
                "SELECT password_hash FROM hyori_credentials WHERE user_id=$1 FOR UPDATE",
                vec![user_id.clone().into()],
            ))
            .await?
            .ok_or_else(ApiError::required)?;
        if row.try_get::<String>("", "password_hash")? != old {
            return Err(ApiError::credentials());
        }
        self.state
            .auth
            .require_actor(&tx, context.session.as_deref())
            .await?
            .require_owner(actor.user_id())?;
        tx.execute_raw(sql(
            "UPDATE hyori_credentials SET password_hash=$2,updated_at=now() WHERE user_id=$1",
            vec![user_id.clone().into(), hash.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "DELETE FROM hyori_password_resets WHERE user_id=$1",
            vec![user_id.clone().into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "DELETE FROM hyori_sessions WHERE user_id=$1 AND token_digest<>$2",
            vec![
                user_id.into(),
                digest(context.session.as_deref().ok_or_else(ApiError::required)?).into(),
            ],
        ))
        .await?;
        tx.commit().await?;
        Ok(Done { success: true })
    }

    pub async fn create_reset(
        &self,
        context: &RequestContext,
        input: CreatePasswordReset,
    ) -> Result<PasswordResetLink, ApiError> {
        let preflight = begin(&self.state.db).await?;
        self.state
            .auth
            .require_admin(&preflight, context.session.as_deref())
            .await?;
        preflight.commit().await?;
        let tx = begin(&self.state.db).await?;
        // Same lock as change/reset; deleting users cannot receive a usable reset link.
        tx.query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
            vec![input.user_id.0.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::denied)?;
        tx.query_one_raw(sql(
            "SELECT user_id FROM hyori_credentials WHERE user_id=$1 FOR UPDATE",
            vec![input.user_id.0.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::denied)?;
        self.state
            .auth
            .require_admin(&tx, context.session.as_deref())
            .await?;
        let token = random_token();
        let row = tx.query_one_raw(sql("INSERT INTO hyori_password_resets(user_id,token_digest,expires_at) VALUES ($1,$2,now()+interval '24 hours') ON CONFLICT(user_id) DO UPDATE SET token_digest=EXCLUDED.token_digest,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at RETURNING expires_at",vec![input.user_id.0.into(),digest(&token).into()])).await?.ok_or_else(ApiError::unavailable)?;
        let expires: chrono::DateTime<chrono::Utc> = row.try_get("", "expires_at")?;
        tx.commit().await?;
        Ok(PasswordResetLink {
            token,
            expires_at: expires.to_rfc3339(),
        })
    }

    pub async fn reset(
        &self,
        context: &RequestContext,
        input: ResetPassword,
    ) -> Result<PasswordResetResult, ApiError> {
        let token_digest = digest(&input.token);
        self.state
            .auth
            .rate_limits(
                &self.state.db,
                &crate::auth::secret_limits(
                    &format!("password-reset:{token_digest}"),
                    context.client,
                ),
            )
            .await?;
        let row = self.state.db.query_one_raw(sql("SELECT r.user_id FROM hyori_password_resets r JOIN hyori_users u ON u.id=r.user_id WHERE r.token_digest=$1 AND r.expires_at>now() AND u.status='active'",vec![token_digest.clone().into()])).await?.ok_or_else(ApiError::denied)?;
        let user_id: String = row.try_get("", "user_id")?;
        let hash = self
            .state
            .auth
            .hash_account_password(&input.new_password)
            .await?;
        let tx = begin(&self.state.db).await?;
        tx.query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
            vec![user_id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::denied)?;
        tx.query_one_raw(sql(
            "SELECT user_id FROM hyori_credentials WHERE user_id=$1 FOR UPDATE",
            vec![user_id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::denied)?;
        // Recheck after KDF and under the account lock: two requests cannot redeem the same token.
        tx.query_one_raw(sql("DELETE FROM hyori_password_resets WHERE user_id=$1 AND token_digest=$2 AND expires_at>clock_timestamp() RETURNING user_id",vec![user_id.clone().into(),token_digest.into()])).await?.ok_or_else(ApiError::denied)?;
        tx.execute_raw(sql(
            "UPDATE hyori_credentials SET password_hash=$2,updated_at=now() WHERE user_id=$1",
            vec![user_id.clone().into(), hash.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "DELETE FROM hyori_sessions WHERE user_id=$1",
            vec![user_id.clone().into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(PasswordResetResult {
            done: Done { success: true },
            user_id: Id(user_id),
        })
    }
}

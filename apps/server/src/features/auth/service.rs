use crate::{
    AppState,
    auth::{IssuedSession, digest, random_token},
    db::{begin, sql},
    error::{ApiError, ErrorCode},
    features::{
        admin::api::{CreateInvite, CreateUser, Invite},
        auth::api::*,
    },
    wire::Nullable,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

pub struct AuthService<'a> {
    state: &'a AppState,
}
impl<'a> AuthService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }
    pub async fn status(&self, token: Option<&str>) -> Result<AuthStatus, ApiError> {
        let tx = begin(&self.state.db).await?;
        let row = tx
            .query_one_raw(sql(
                "SELECT initialized FROM hyori_bootstrap WHERE singleton=true",
                vec![],
            ))
            .await?
            .ok_or_else(ApiError::unavailable)?;
        let current = self.state.auth.authenticate(&tx, token).await?;
        let status = AuthStatus {
            initialized: row.try_get("", "initialized")?,
            user: Nullable(current.map(|current| current.user)),
        };
        tx.commit().await?;
        Ok(status)
    }
    pub async fn setup(&self, mut input: Setup) -> Result<IssuedSession, ApiError> {
        self.state.auth.rate_limit(&self.state.db, "setup").await?;
        if !bool::from(
            digest(&input.setup_token)
                .as_bytes()
                .ct_eq(digest(&self.state.config.setup_token).as_bytes()),
        ) {
            return Err(setup_denied());
        }
        normalize_account(&mut input.account)?;
        let tx = Arc::new(begin(&self.state.db).await?);
        let row = tx
            .query_one_raw(sql(
                "SELECT initialized FROM hyori_bootstrap WHERE singleton=true FOR UPDATE",
                vec![],
            ))
            .await?
            .ok_or_else(ApiError::unavailable)?;
        if row.try_get::<bool>("", "initialized")? {
            return Err(setup_denied());
        }
        let session = self
            .create_account(
                tx.clone(),
                &input.account,
                UserRole::Admin,
                self.state.config.default_quota_bytes,
            )
            .await?;
        tx.execute_raw(sql(
            "UPDATE hyori_bootstrap SET initialized=true,admin_id=$1 WHERE singleton=true",
            vec![session.user.id.0.clone().into()],
        ))
        .await?;
        commit(tx).await?;
        Ok(session)
    }
    pub async fn login(&self, mut input: Credentials) -> Result<IssuedSession, ApiError> {
        input.email = normalize_email(&input.email)?;
        self.state
            .auth
            .rate_limit(&self.state.db, &format!("login:{}", input.email))
            .await?;
        let tx = Arc::new(begin(&self.state.db).await?);
        let session = self.state.auth.login(tx.clone(), &input).await?;
        commit(tx).await?;
        Ok(session)
    }
    pub async fn logout(&self, token: Option<&str>) -> Result<Done, ApiError> {
        let tx = Arc::new(begin(&self.state.db).await?);
        self.state.auth.logout(tx.clone(), token).await?;
        commit(tx).await?;
        Ok(Done { success: true })
    }
    pub async fn accept_invite(&self, mut input: AcceptInvite) -> Result<IssuedSession, ApiError> {
        self.state
            .auth
            .rate_limit(&self.state.db, &format!("invite:{}", digest(&input.token)))
            .await?;
        normalize_account(&mut input.account)?;
        let tx = Arc::new(begin(&self.state.db).await?);
        let invite = tx.query_one_raw(sql("SELECT i.email FROM hyori_invites i JOIN hyori_users u ON u.id=i.issuer_id WHERE i.token_digest=$1 AND i.expires_at>now() AND i.consumed_at IS NULL AND u.status='active' AND u.role='admin' FOR UPDATE OF i FOR SHARE OF u", vec![digest(&input.token).into()])).await?.ok_or_else(ApiError::denied)?;
        if invite
            .try_get::<Option<String>>("", "email")?
            .is_some_and(|email| email != input.account.email)
        {
            return Err(ApiError::denied());
        }
        let session = self
            .create_account(
                tx.clone(),
                &input.account,
                UserRole::User,
                self.state.config.default_quota_bytes,
            )
            .await?;
        tx.execute_raw(sql(
            "UPDATE hyori_invites SET consumed_at=now() WHERE token_digest=$1",
            vec![digest(&input.token).into()],
        ))
        .await?;
        commit(tx).await?;
        Ok(session)
    }
    async fn create_account(
        &self,
        tx: Arc<DatabaseTransaction>,
        input: &NewAccount,
        role: UserRole,
        quota: u64,
    ) -> Result<IssuedSession, ApiError> {
        if tx
            .query_one_raw(sql(
                "SELECT id FROM hyori_users WHERE email=$1",
                vec![input.email.clone().into()],
            ))
            .await?
            .is_some()
        {
            return Err(ApiError::conflict());
        }
        self.state.auth.signup(tx, input, role, quota).await
    }
    /// Controlled account admission shares the exact transaction and credential path with bootstrap/invites.
    pub async fn create_user(
        &self,
        token: Option<&str>,
        mut input: CreateUser,
    ) -> Result<User, ApiError> {
        normalize_account(&mut input.account)?;
        let preflight = begin(&self.state.db).await?;
        let admin = self.state.auth.require_admin(&preflight, token).await?;
        preflight.commit().await?;
        // Rate consumption survives failed admission without holding a pool connection
        // while acquiring another. Authority is checked again in the committing transaction.
        self.state
            .auth
            .rate_limit(
                &self.state.db,
                &format!("create-account:{}", admin.user_id().0),
            )
            .await?;
        let tx = Arc::new(begin(&self.state.db).await?);
        self.state.auth.require_admin(&tx, token).await?;
        let session = self
            .create_account(
                tx.clone(),
                &input.account,
                UserRole::User,
                input
                    .quota_bytes
                    .map_or(self.state.config.default_quota_bytes, |bytes| bytes.0),
            )
            .await?;
        self.state
            .auth
            .logout(tx.clone(), Some(&session.token))
            .await?;
        commit(tx).await?;
        Ok(session.user)
    }
    pub async fn create_invite(
        &self,
        token: Option<&str>,
        input: CreateInvite,
    ) -> Result<Invite, ApiError> {
        let email = input.email.as_deref().map(normalize_email).transpose()?;
        let expires = input
            .expires_at
            .map(|stamp| stamp.parse())
            .transpose()?
            .unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::days(7));
        if expires <= chrono::Utc::now() {
            return Err(ApiError::invalid());
        }
        let tx = begin(&self.state.db).await?;
        let admin = self.state.auth.require_admin(&tx, token).await?;
        let invite = random_token();
        tx.execute_raw(sql("INSERT INTO hyori_invites(token_digest,issuer_id,email,expires_at) VALUES ($1,$2,$3,$4)", vec![digest(&invite).into(), admin.user_id().0.clone().into(), email.into(), expires.into()])).await?;
        tx.commit().await?;
        Ok(Invite {
            token: invite,
            expires_at: expires.to_rfc3339(),
        })
    }
}
async fn commit(tx: Arc<DatabaseTransaction>) -> Result<(), ApiError> {
    Arc::try_unwrap(tx)
        .map_err(|_| ApiError::unavailable())?
        .commit()
        .await?;
    Ok(())
}
fn setup_denied() -> ApiError {
    ApiError::new(
        ErrorCode::SetupDenied,
        "Setup is not authorized or instance is already initialized",
    )
}
pub fn normalize_email(value: &str) -> Result<String, ApiError> {
    let value: String = value.trim().nfc().collect::<String>().to_lowercase();
    let Some((local, domain)) = value.split_once('@') else {
        return Err(ApiError::invalid());
    };
    if local.is_empty()
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || value.chars().count() > 254
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
        || domain.contains('@')
    {
        return Err(ApiError::invalid());
    }
    Ok(value)
}
fn normalize_account(input: &mut NewAccount) -> Result<(), ApiError> {
    input.email = normalize_email(&input.email)?;
    input.name.0 = input.name.0.trim().nfc().collect();
    if input.name.0.is_empty()
        || input.name.0.chars().count() > 255
        || input.name.0.chars().any(char::is_control)
    {
        return Err(ApiError::invalid());
    }
    Ok(())
}

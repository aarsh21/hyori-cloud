use crate::{
    auth::{digest, random_token},
    config::SESSION_SECONDS,
    db::sql,
};
use async_trait::async_trait;
use better_auth_core::{
    self as ba, AuthError, AuthResult, AuthSchema, FieldMap, FromFieldMap,
    store::*,
    types::*,
    wire::{AccountView, SessionView, UserView},
};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};
use std::sync::Arc;

pub(super) struct HyoriSchema;
impl AuthSchema for HyoriSchema {
    type User = UserView;
    type Session = SessionView;
    type Account = AccountView;
    type Verification = ();
}
#[derive(Clone)]
pub(super) struct Provision {
    pub role: String,
    pub quota: i64,
}
#[derive(Clone)]
pub(super) struct PgStore {
    pub tx: Arc<DatabaseTransaction>,
    pub provision: Option<Provision>,
}
fn failure(_: sea_orm::DbErr) -> AuthError {
    AuthError::internal("Auth persistence unavailable")
}
fn disabled<T>() -> AuthResult<T> {
    Err(AuthError::config(
        "Capability disabled by Hyori auth adapter",
    ))
}
fn field_text(fields: &FieldMap, name: &str) -> AuthResult<String> {
    fields
        .get(name)
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| AuthError::bad_request("Missing auth field"))
}
fn user_view(row: QueryResult) -> AuthResult<UserView> {
    let fields = FieldMap::from([
        (
            "id".into(),
            row.try_get::<String>("", "id").map_err(failure)?.into(),
        ),
        (
            "name".into(),
            row.try_get::<String>("", "name").map_err(failure)?.into(),
        ),
        (
            "email".into(),
            row.try_get::<String>("", "email").map_err(failure)?.into(),
        ),
        ("emailVerified".into(), false.into()),
        (
            "createdAt".into(),
            ba::FieldDate::from(
                row.try_get::<DateTime<Utc>>("", "created_at")
                    .map_err(failure)?,
            )
            .into(),
        ),
        (
            "updatedAt".into(),
            ba::FieldDate::from(
                row.try_get::<DateTime<Utc>>("", "updated_at")
                    .map_err(failure)?,
            )
            .into(),
        ),
    ]);
    UserView::from_field_values(fields)
}
fn account_view(row: QueryResult) -> AuthResult<AccountView> {
    AccountView::from_field_values(FieldMap::from([
        (
            "id".into(),
            row.try_get::<String>("", "id").map_err(failure)?.into(),
        ),
        (
            "userId".into(),
            row.try_get::<String>("", "user_id")
                .map_err(failure)?
                .into(),
        ),
        (
            "accountId".into(),
            row.try_get::<String>("", "user_id")
                .map_err(failure)?
                .into(),
        ),
        ("providerId".into(), "credential".into()),
        (
            "password".into(),
            row.try_get::<String>("", "password_hash")
                .map_err(failure)?
                .into(),
        ),
        (
            "createdAt".into(),
            ba::FieldDate::from(
                row.try_get::<DateTime<Utc>>("", "created_at")
                    .map_err(failure)?,
            )
            .into(),
        ),
        (
            "updatedAt".into(),
            ba::FieldDate::from(
                row.try_get::<DateTime<Utc>>("", "updated_at")
                    .map_err(failure)?,
            )
            .into(),
        ),
    ]))
}
macro_rules! store_impl {
    ($trait:ident { $($implemented:item)* } disabled { $($(#[$attr:meta])* async fn $name:ident($($arg:tt)*) -> $result:ty;)* }) => {
        #[async_trait]
        impl $trait<HyoriSchema> for PgStore {
            $($implemented)*
            $($(#[$attr])* async fn $name($($arg)*) -> $result { disabled() })*
        }
    };
}
store_impl!(UserStore {
    async fn create_user(&self, input: CreateUser) -> AuthResult<UserView> {
        UserStore::create_user_fields_optional(self, input.into_user_fields()?).await?.ok_or_else(|| AuthError::internal("User not created"))
    }
    async fn create_user_fields_optional(&self, input: FieldMap) -> AuthResult<Option<UserView>> {
        let policy = self.provision.as_ref().ok_or_else(|| AuthError::forbidden("Controlled provisioning required"))?;
        let id = random_token();
        let email = field_text(&input, "email")?;
        let name = field_text(&input, "name")?;
        let row = self.tx.query_one_raw(sql("INSERT INTO hyori_users(id,email,name,role,quota_bytes) VALUES ($1,$2,$3,$4,$5) RETURNING *", vec![id.into(), email.into(), name.into(), policy.role.clone().into(), policy.quota.into()])).await.map_err(failure)?.ok_or_else(|| AuthError::internal("User not created"))?;
        user_view(row).map(Some)
    }
    async fn get_user_by_id(&self, id: &str) -> AuthResult<Option<UserView>> {
        self.tx.query_one_raw(sql("SELECT * FROM hyori_users WHERE id=$1 AND status='active' FOR SHARE", vec![id.into()])).await.map_err(failure)?.map(user_view).transpose()
    }
    async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<UserView>> {
        self.tx.query_one_raw(sql("SELECT * FROM hyori_users WHERE email=$1 AND status='active' FOR SHARE", vec![email.into()])).await.map_err(failure)?.map(user_view).transpose()
    }
    async fn get_user_with_accounts(&self, email: &str) -> AuthResult<Option<UserAccounts>> {
        let Some(user) = UserStore::get_user_by_email(self, email).await? else { return Ok(None) };
        let accounts = AccountStore::get_user_accounts(self, user.id.typed()?).await?;
        Ok(Some(UserAccounts { user, accounts: JoinValue::Many(accounts) }))
    }
} disabled {
    async fn verify_user_and_revoke_unproven_access(&self, _user_id: &str) -> AuthResult<Option<UserView>>;
    async fn list_users_by_ids(&self, _ids: &[String], _limit: f64) -> AuthResult<Vec<UserView>>;
    async fn get_user_by_username(&self, _username: &str) -> AuthResult<Option<UserView>>;
    async fn get_user_by_phone_number(&self, _phone_number: &str) -> AuthResult<Option<UserView>>;
    async fn update_user(&self, _id: &str, _update: UpdateUser) -> AuthResult<UserView>;
    async fn delete_user(&self, _id: &str) -> AuthResult<()>;
    async fn list_users(&self, _params: ListUsersParams) -> AuthResult<(Vec<UserView>, usize)>;
});
store_impl!(AccountStore {
    async fn create_account(&self, input: CreateAccount) -> AuthResult<AccountView> {
        if self.provision.is_none() || input.provider_id.typed()? != "credential" || input.account_id.typed()? != input.user_id.typed()? { return disabled(); }
        let password = input.password.typed()?.as_ref().ok_or_else(|| AuthError::bad_request("Password required"))?;
        let row = self.tx.query_one_raw(sql("INSERT INTO hyori_credentials(id,user_id,password_hash) VALUES ($1,$2,$3) RETURNING *", vec![random_token().into(), input.user_id.typed()?.clone().into(), password.clone().into()])).await.map_err(failure)?.ok_or_else(|| AuthError::internal("Credential not created"))?;
        account_view(row)
    }
    async fn get_account(&self, provider: &str, id: &str) -> AuthResult<Option<AccountView>> {
        if provider != "credential" { return disabled(); }
        AccountStore::get_credential_account(self, id).await
    }
    async fn get_user_accounts(&self, user_id: &str) -> AuthResult<Vec<AccountView>> {
        Ok(AccountStore::get_credential_account(self, user_id).await?.into_iter().collect())
    }
    async fn get_credential_account(&self, user_id: &str) -> AuthResult<Option<AccountView>> {
        self.tx.query_one_raw(sql("SELECT * FROM hyori_credentials WHERE user_id=$1", vec![user_id.into()])).await.map_err(failure)?.map(account_view).transpose()
    }
} disabled {
    async fn update_account(&self, _id: &str, _update: UpdateAccount) -> AuthResult<AccountView>;
    async fn delete_account(&self, _id: &str) -> AuthResult<()>;
});
store_impl!(SessionStore {
    async fn create_session(&self, input: CreateSession) -> AuthResult<SessionView> {
        let id = random_token(); let token = random_token();
        let now = Utc::now(); let expiry = now + chrono::Duration::seconds(SESSION_SECONDS);
        let user_id = input.user_id.typed()?.clone();
        if UserStore::get_user_by_id(self, &user_id).await?.is_none() { return Err(AuthError::InvalidCredentials); }
        self.tx.execute_raw(sql("INSERT INTO hyori_sessions(id,token_digest,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)", vec![id.clone().into(), digest(&token).into(), user_id.clone().into(), now.into(), expiry.into()])).await.map_err(failure)?;
        Ok(SessionView { id: id.into(), token: token.into(), user_id: user_id.into(), created_at: ba::FieldDate::from(now).into(), updated_at: ba::FieldDate::from(now).into(), expires_at: ba::FieldDate::from(expiry).into(), active: true, ..Default::default() })
    }
    async fn create_session_optional(&self, input: CreateSession) -> AuthResult<Option<SessionView>> { SessionStore::create_session(self, input).await.map(Some) }
    async fn get_session(&self, token: &str) -> AuthResult<Option<SessionView>> {
        let Some(row) = self.tx.query_one_raw(sql("SELECT s.* FROM hyori_sessions s JOIN hyori_users u ON u.id=s.user_id WHERE s.token_digest=$1 AND s.expires_at>now() AND u.status='active' FOR SHARE OF s,u", vec![digest(token).into()])).await.map_err(failure)? else { return Ok(None) };
        let now = row.try_get::<DateTime<Utc>>("", "created_at").map_err(failure)?;
        Ok(Some(SessionView { id: row.try_get::<String>("", "id").map_err(failure)?.into(), token: token.to_owned().into(), user_id: row.try_get::<String>("", "user_id").map_err(failure)?.into(), created_at: ba::FieldDate::from(now).into(), updated_at: ba::FieldDate::from(now).into(), expires_at: ba::FieldDate::from(row.try_get::<DateTime<Utc>>("", "expires_at").map_err(failure)?).into(), active: true, ..Default::default() }))
    }
    async fn delete_session(&self, token: &str) -> AuthResult<()> {
        self.tx.execute_raw(sql("DELETE FROM hyori_sessions WHERE token_digest=$1", vec![digest(token).into()])).await.map_err(failure)?; Ok(())
    }
    async fn delete_user_sessions(&self, user_id: &str) -> AuthResult<()> {
        self.tx.execute_raw(sql("DELETE FROM hyori_sessions WHERE user_id=$1", vec![user_id.into()])).await.map_err(failure)?; Ok(())
    }
} disabled {
    async fn accept_invitation_with_teams(&self, _invitation_id: &str, _user_id: &str, _session_token: Option<&str>, _teams_enabled: bool, _maximum: TeamMemberLimits<'_>) -> AuthResult<(Member, Invitation, Option<SessionView>)>;
    async fn get_session_snapshots(&self, _tokens: &[String], _only_active: bool) -> AuthResult<Vec<(SessionView, Option<ba::session::SessionData<JoinValue<UserView>>>)>>;
    async fn update_session_fields(&self, _token: &str, _fields: FieldMap) -> AuthResult<Option<SessionView>>;
    async fn get_user_sessions(&self, _user_id: &str) -> AuthResult<Vec<SessionView>>;
    async fn update_session_expiry(&self, _token: &str, _expires_at: DateTime<Utc>) -> AuthResult<SessionView>;
    async fn delete_expired_sessions(&self) -> AuthResult<usize>;
    async fn update_session_active_team(&self, _token: &str, _team_id: Option<&str>) -> AuthResult<SessionView>;
    async fn update_session_active_organization(&self, _token: &str, _organization_id: Option<&str>) -> AuthResult<SessionView>;
});
store_impl!(AuthTransaction {
    fn clone_handle(&self) -> Arc<dyn AuthTransaction<HyoriSchema>> { Arc::new(self.clone()) }
    fn queue_after_commit(&self, _effect: TypedTransactionFuture<'static, ()>) -> AuthResult<()> { disabled() }
    async fn create_user_fields_optional(&self, input: FieldMap) -> AuthResult<Option<UserView>> { UserStore::create_user_fields_optional(self, input).await }
    async fn create_user(&self, input: CreateUser) -> AuthResult<UserView> { UserStore::create_user(self, input).await }
    async fn create_account(&self, input: CreateAccount) -> AuthResult<AccountView> { AccountStore::create_account(self, input).await }
    async fn create_account_optional(&self, input: CreateAccount) -> AuthResult<Option<AccountView>> { AccountStore::create_account(self, input).await.map(Some) }
    async fn create_session(&self, input: CreateSession) -> AuthResult<SessionView> { SessionStore::create_session(self, input).await }
    async fn create_session_optional(&self, input: CreateSession) -> AuthResult<Option<SessionView>> { SessionStore::create_session(self, input).await.map(Some) }
    async fn get_user_by_id(&self, id: &str) -> AuthResult<Option<UserView>> { UserStore::get_user_by_id(self, id).await }
    async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<UserView>> { UserStore::get_user_by_email(self, email).await }
} disabled {
    async fn create_verification(&self, _verification: CreateVerification) -> AuthResult<ba::wire::VerificationView>;
    async fn update_verification(&self, _identifier: &str, _update: database_hooks::VerificationUpdate) -> AuthResult<Option<ba::wire::VerificationView>>;
    async fn get_verification_including_expired(&self, _identifier: &str) -> AuthResult<Option<ba::wire::VerificationView>>;
    async fn delete_verification_by_identifier(&self, _identifier: &str) -> AuthResult<()>;
    async fn delete_expired_verifications(&self) -> AuthResult<usize>;
    async fn update_user(&self, _id: &str, _update: UpdateUser) -> AuthResult<UserView>;
    async fn delete_user(&self, _id: &str) -> AuthResult<()>;
    async fn create_passkey(&self, _passkey: CreatePasskey) -> AuthResult<Passkey>;
});
#[async_trait]
impl TransactionStore<HyoriSchema> for PgStore {
    async fn transaction_boxed(
        &self,
        work: Box<TransactionWork<HyoriSchema>>,
    ) -> AuthResult<BoxedTransactionValue> {
        work(self).await
    }
}
impl RuntimeStore<HyoriSchema> for PgStore {
    fn adapter_id(&self) -> &'static str {
        "hyori-postgres"
    }
    fn with_runtime(
        &self,
        _config: Arc<ba::AuthConfig>,
        hooks: Vec<Arc<dyn database_hooks::DatabaseHooks<HyoriSchema>>>,
        _fields: ba::plugin_runtime::ModelFields,
    ) -> AuthResult<Arc<dyn AuthStore<HyoriSchema>>> {
        if !hooks.is_empty() {
            return disabled();
        }
        Ok(Arc::new(self.clone()))
    }
}

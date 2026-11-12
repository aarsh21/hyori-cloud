mod credentials;
mod disabled;
mod password;
pub use password::{SIGN_IN_RUNNING, SIGN_IN_WAITING};
mod store;

use crate::{
    config::{Config, SESSION_SECONDS},
    db::{begin, sql},
    error::{ApiError, ErrorCode},
    features::auth::api::{
        Bytes, Id, NEW_PASSWORD_MIN_CHARS, Name, PASSWORD_MAX_CHARS, User, UserRole,
    },
};
use better_auth::{
    AuthConfig, BetterAuth, plugins::EmailPasswordPlugin, server_api::EndpointInput,
};
use better_auth_core::{HttpMethod, store::SessionStore};
use password::{BoundedHasher, SignInLane};
use rand::RngCore;
use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction, QueryResult};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use store::{HyoriSchema, PgStore, Provision};
use tokio::time::Instant;

pub const RATE_LIMIT_WINDOW_SECONDS: i64 = 15 * 60;
/// Attempts per window for one secret (a share link, invite or password-reset link) from one client,
/// or from everyone together when no client address is known.
pub const SECRET_ATTEMPTS: i32 = 10;
/// Attempts per window for one secret from all identified clients together.
pub const SECRET_ATTEMPTS_ALL_CLIENTS: i32 = 100;

/// Which counters one guess at the secret `scope` spends. With a client address, each client has
/// its own budget, so strangers cannot lock everyone else out, and the secret keeps a ceiling
/// across clients, so distributed guessing stays bounded. The client's own budget is spent first:
/// one client adds at most [`SECRET_ATTEMPTS`] to the ceiling. Without an address the secret has
/// one shared budget, as before client addresses existed.
pub fn secret_limits(scope: &str, client: Option<std::net::IpAddr>) -> Vec<(String, i32)> {
    match client {
        Some(client) => vec![
            (
                format!("{scope}:client:{}", crate::rpc::client_key(client)),
                SECRET_ATTEMPTS,
            ),
            (format!("{scope}:all-clients"), SECRET_ATTEMPTS_ALL_CLIENTS),
        ],
        None => vec![(scope.to_owned(), SECRET_ATTEMPTS)],
    }
}

fn validate_password_length(password: &str, minimum: usize) -> Result<(), ApiError> {
    let count = password.chars().take(PASSWORD_MAX_CHARS + 1).count();
    if !(minimum..=PASSWORD_MAX_CHARS).contains(&count) {
        return Err(ApiError::invalid());
    }
    Ok(())
}

pub fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// HMAC-SHA-256 (RFC 2104).
pub(crate) fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
    let mut key = [0_u8; 64];
    if secret.len() > key.len() {
        key[..32].copy_from_slice(&Sha256::digest(secret));
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let inner = Sha256::new()
        .chain_update(key.map(|b| b ^ 0x36))
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(key.map(|b| b ^ 0x5c))
        .chain_update(inner)
        .finalize()
        .into()
}
#[derive(Clone)]
pub struct AuthAdapter {
    config: Arc<Config>,
    hasher: Arc<BoundedHasher>,
    sign_in: Arc<SignInLane>,
}
/// Identity is derived only from a current session and active account within the caller's transaction.
/// Deliberately no admin capability: ordinary file authorization must use identity and explicit grants.
#[derive(Clone, Debug)]
pub struct Actor {
    user_id: Id,
}
impl Actor {
    pub fn user_id(&self) -> &Id {
        &self.user_id
    }
    pub fn require_owner(&self, owner_id: &Id) -> Result<(), ApiError> {
        if self.user_id == *owner_id {
            Ok(())
        } else {
            Err(ApiError::denied())
        }
    }
}
pub struct Authenticated {
    pub actor: Actor,
    pub user: User,
}
#[derive(Deserialize)]
struct AuthResultWire {
    token: String,
    user: AuthUserId,
}
#[derive(Deserialize)]
struct AuthUserId {
    id: String,
}
pub struct IssuedSession {
    pub user: User,
    pub token: String,
}

pub fn project_user(row: &QueryResult) -> Result<User, ApiError> {
    Ok(User {
        id: Id(row.try_get("", "id")?),
        email: row.try_get("", "email")?,
        name: Name(row.try_get("", "name")?),
        role: match row.try_get::<String>("", "role")?.as_str() {
            "admin" => UserRole::Admin,
            "user" => UserRole::User,
            _ => return Err(ApiError::unavailable()),
        },
        quota_bytes: Bytes(
            row.try_get::<i64>("", "quota_bytes")?
                .try_into()
                .map_err(|_| ApiError::unavailable())?,
        ),
        used_bytes: Bytes(
            row.try_get::<i64>("", "used_bytes")?
                .try_into()
                .map_err(|_| ApiError::unavailable())?,
        ),
    })
}
impl AuthAdapter {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            hasher: Arc::new(BoundedHasher::new()),
            sign_in: Arc::new(SignInLane::new()),
        }
    }
    async fn runtime(
        &self,
        tx: Arc<DatabaseTransaction>,
        provision: Option<Provision>,
    ) -> Result<BetterAuth<HyoriSchema>, ApiError> {
        let mut config = AuthConfig::new(self.config.auth_secret.clone())
            .base_url(self.config.origin.clone())
            .session_expires_in(chrono::Duration::seconds(SESSION_SECONDS))
            .disable_session_refresh(true);
        config.telemetry.enabled = false;
        // No auth router is mounted. Only trusted, validated operations call these endpoints.
        BetterAuth::new(config)
            .store(PgStore { tx, provision })
            .plugin(
                EmailPasswordPlugin::new()
                    .enable_signup(true)
                    .require_email_verification(false)
                    .password_min_length(NEW_PASSWORD_MIN_CHARS)
                    // The owned boundary enforces code points; upstream counts UTF-16 units.
                    .password_max_length(PASSWORD_MAX_CHARS * 2)
                    .password_hasher(self.hasher.clone()),
            )
            .build()
            .await
            .map_err(map_auth_error)
    }
    pub async fn signup(
        &self,
        tx: Arc<DatabaseTransaction>,
        input: &crate::features::auth::api::NewAccount,
        role: UserRole,
        quota: u64,
    ) -> Result<IssuedSession, ApiError> {
        validate_password_length(&input.password, NEW_PASSWORD_MIN_CHARS)?;
        let provision = Provision {
            role: if role == UserRole::Admin {
                "admin"
            } else {
                "user"
            }
            .into(),
            quota: quota.try_into().map_err(|_| ApiError::invalid())?,
        };
        let auth = self.runtime(tx.clone(), Some(provision)).await?;
        let body = serde_json::to_value(input).map_err(|_| ApiError::invalid())?;
        let response = auth
            .call_endpoint(HttpMethod::Post, "/sign-up/email", self.input(body))
            .await
            .map_err(map_auth_error)?;
        self.issued(&tx, response).await
    }
    /// Signs in without holding a transaction or connection while the password is checked.
    /// None is a failed sign-in, whatever the reason: no usable account (nothing is hashed), a
    /// wrong password, a check unfinished by `deadline`, or a password replaced meanwhile. The
    /// caller answers them all alike at the deadline. A busy answer depends on the lane only.
    ///
    /// Whether the lane is busy is decided before `limits` are spent, so a busy answer is never
    /// counted as an attempt. An email with an account takes a place in the lane there; one
    /// without is answered busy under exactly the same lane state and holds no place.
    pub async fn login(
        &self,
        db: &DatabaseConnection,
        input: &crate::features::auth::api::Credentials,
        limits: &[(String, i32)],
        deadline: Instant,
    ) -> Result<Option<IssuedSession>, ApiError> {
        validate_password_length(&input.password, 1)?;
        let account = db
            .query_one_raw(sql(
                "SELECT u.id,c.password_hash FROM hyori_users u JOIN hyori_credentials c ON c.user_id=u.id WHERE u.email=$1 AND u.status='active'",
                vec![input.email.clone().into()],
            ))
            .await?;
        let busy = || {
            ApiError::new(
                ErrorCode::SignInBusy,
                "Sign-in is busy. Try again in a moment",
            )
        };
        let Some(account) = account else {
            if self.sign_in.is_full() {
                return Err(busy());
            }
            self.rate_limits(db, limits).await?;
            return Ok(None);
        };
        let place = self.sign_in.admit().ok_or_else(busy)?;
        self.rate_limits(db, limits).await?;
        let user_id: String = account.try_get("", "id")?;
        let verified: String = account.try_get("", "password_hash")?;
        if place
            .verify(verified.clone(), input.password.clone(), deadline)
            .await
            != Some(true)
        {
            return Ok(None);
        }
        let tx = begin(db).await?;
        // Locks in the order a password change takes them: the user row, then its credential.
        // KEY SHARE fences account deletion; FOR SHARE on the credential conflicts with the FOR
        // UPDATE a password change or reset takes on it (and with a plain UPDATE). Either the
        // change committed first and this reads its new hash, or it waits for this session to
        // commit and then ends it.
        let active = tx
            .query_one_raw(sql(
                "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
                vec![user_id.clone().into()],
            ))
            .await?;
        let current = match active {
            Some(_) => tx
                .query_one_raw(sql(
                    "SELECT password_hash FROM hyori_credentials WHERE user_id=$1 FOR SHARE",
                    vec![user_id.clone().into()],
                ))
                .await?
                .map(|row| row.try_get::<String>("", "password_hash"))
                .transpose()?,
            None => None,
        };
        if current.as_deref() != Some(verified.as_str()) {
            return Ok(None);
        }
        let session = store::insert_session(&tx, &user_id).await?;
        let user = tx
            .query_one_raw(sql(
                "SELECT * FROM hyori_users WHERE id=$1",
                vec![user_id.into()],
            ))
            .await?
            .ok_or_else(ApiError::unavailable)?;
        let user = project_user(&user)?;
        tx.commit().await?;
        Ok(Some(IssuedSession {
            user,
            token: session.token,
        }))
    }
    fn input(&self, body: serde_json::Value) -> EndpointInput {
        EndpointInput {
            body: Some(body),
            headers: Some(HashMap::from([
                ("origin".into(), self.config.origin.clone()),
                ("content-type".into(), "application/json".into()),
            ])),
            ..Default::default()
        }
    }
    async fn issued(
        &self,
        tx: &DatabaseTransaction,
        response: better_auth_core::AuthResponse,
    ) -> Result<IssuedSession, ApiError> {
        let body = response
            .body
            .json()
            .map_err(map_auth_error)?
            .ok_or_else(ApiError::unavailable)?;
        let issued: AuthResultWire =
            serde_json::from_value(body).map_err(|_| ApiError::unavailable())?;
        if issued.token.len() != 64 {
            return Err(ApiError::unavailable());
        }
        let row = tx
            .query_one_raw(sql(
                "SELECT * FROM hyori_users WHERE id=$1 AND status='active'",
                vec![issued.user.id.into()],
            ))
            .await?
            .ok_or_else(ApiError::unavailable)?;
        Ok(IssuedSession {
            user: project_user(&row)?,
            token: issued.token,
        })
    }
    pub async fn authenticate(
        &self,
        tx: &DatabaseTransaction,
        token: Option<&str>,
    ) -> Result<Option<Authenticated>, ApiError> {
        let Some(token) =
            token.filter(|token| token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()))
        else {
            return Ok(None);
        };
        let row = tx.query_one_raw(sql("SELECT u.* FROM hyori_sessions s JOIN hyori_users u ON u.id=s.user_id WHERE s.token_digest=$1 AND s.expires_at>now() AND u.status='active' FOR SHARE OF s FOR KEY SHARE OF u", vec![digest(token).into()])).await?;
        row.map(|row| {
            let user = project_user(&row)?;
            Ok(Authenticated {
                actor: Actor {
                    user_id: user.id.clone(),
                },
                user,
            })
        })
        .transpose()
    }
    pub async fn require_actor(
        &self,
        tx: &DatabaseTransaction,
        token: Option<&str>,
    ) -> Result<Actor, ApiError> {
        self.authenticate(tx, token)
            .await?
            .map(|current| current.actor)
            .ok_or_else(ApiError::required)
    }
    pub async fn require_admin(
        &self,
        tx: &DatabaseTransaction,
        token: Option<&str>,
    ) -> Result<Actor, ApiError> {
        let current = self
            .authenticate(tx, token)
            .await?
            .ok_or_else(ApiError::required)?;
        if current.user.role != UserRole::Admin {
            return Err(ApiError::denied());
        }
        Ok(current.actor)
    }
    pub async fn logout(
        &self,
        tx: Arc<DatabaseTransaction>,
        token: Option<&str>,
    ) -> Result<(), ApiError> {
        if let Some(token) = token {
            SessionStore::delete_session(
                &PgStore {
                    tx,
                    provision: None,
                },
                token,
            )
            .await
            .map_err(map_auth_error)?;
        }
        Ok(())
    }
    /// Fixed-window attempt counter: refuses once `key` has more than `attempts` this window.
    pub async fn rate_limit(
        &self,
        db: &DatabaseConnection,
        key: &str,
        attempts: i32,
    ) -> Result<(), ApiError> {
        let row = db.query_one_raw(sql("INSERT INTO hyori_rate_limits(key_digest,window_start,attempts) VALUES ($1,now(),1) ON CONFLICT(key_digest) DO UPDATE SET window_start=CASE WHEN hyori_rate_limits.window_start <= now()-$2::bigint * interval '1 second' THEN now() ELSE hyori_rate_limits.window_start END, attempts=CASE WHEN hyori_rate_limits.window_start <= now()-$2::bigint * interval '1 second' THEN 1 ELSE LEAST(hyori_rate_limits.attempts+1,$3+1) END RETURNING attempts", vec![digest(key).into(), RATE_LIMIT_WINDOW_SECONDS.into(), attempts.into()])).await?.ok_or_else(ApiError::unavailable)?;
        if row.try_get::<i32>("", "attempts")? > attempts {
            Err(ApiError::limited())
        } else {
            Ok(())
        }
    }
    /// Spends each budget in order and stops at the first one exhausted, so a refused attempt
    /// never reaches the budgets after it.
    pub async fn rate_limits(
        &self,
        db: &DatabaseConnection,
        limits: &[(String, i32)],
    ) -> Result<(), ApiError> {
        for (key, attempts) in limits {
            self.rate_limit(db, key, *attempts).await?;
        }
        Ok(())
    }
    /// Link passwords share one bounded KDF pool with new accounts and password changes; sign-in
    /// verification has its own lane, so none of these can delay it.
    pub async fn hash_link_password(&self, password: &str) -> Result<String, ApiError> {
        use better_auth::PasswordHasher;
        if !(8..=1024).contains(&password.chars().count()) {
            return Err(ApiError::invalid());
        }
        self.hasher.hash(password).await.map_err(map_auth_error)
    }
    pub async fn verify_link_password(&self, hash: &str, password: &str) -> Result<bool, ApiError> {
        use better_auth::PasswordHasher;
        if password.chars().count() > 1024 {
            return Err(ApiError::invalid());
        }
        self.hasher
            .verify(hash, password)
            .await
            .map_err(map_auth_error)
    }
    pub fn cookie(&self, token: Option<&str>) -> String {
        let age = if token.is_some() { SESSION_SECONDS } else { 0 };
        format!(
            "hyori_session={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{}",
            token.unwrap_or(""),
            if self.config.secure_cookies {
                "; Secure"
            } else {
                ""
            }
        )
    }
}
fn map_auth_error(error: better_auth::AuthError) -> ApiError {
    if matches!(error, better_auth::AuthError::InvalidCredentials) {
        return ApiError::credentials();
    }
    match error
        .status_code()
        .ok()
        .and_then(|status| status.typed().ok().copied())
    {
        Some(401) => ApiError::credentials(),
        Some(429) => ApiError::limited(),
        Some(409) | Some(422) => ApiError::conflict(),
        Some(400) => ApiError::new(ErrorCode::InvalidInput, "Invalid account input"),
        _ => {
            tracing::error!(category = "auth", "authentication operation failed");
            ApiError::unavailable()
        }
    }
}

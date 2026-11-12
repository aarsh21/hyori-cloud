use crate::{
    AppState,
    auth::{IssuedSession, digest, random_token},
    db::{begin, sql},
    error::{ApiError, ErrorCode},
    features::{
        admin::api::{CreateInvite, CreateUser, Invite},
        auth::api::*,
    },
    rpc::{DEVICE_COOKIE, RequestContext},
    wire::Nullable,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
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
    pub async fn setup(
        &self,
        mut input: Setup,
        context: &RequestContext,
    ) -> Result<IssuedSession, ApiError> {
        let limits = crate::auth::secret_limits("setup", context.client);
        self.state.auth.rate_limits(&self.state.db, &limits).await?;
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
    /// Returns the session and a device cookie to set alongside it.
    pub async fn login(
        &self,
        mut input: Credentials,
        context: &RequestContext,
    ) -> Result<(IssuedSession, String), ApiError> {
        input.email = normalize_email(&input.email)?;
        let secret = &self.state.config.auth_secret;
        let device = context
            .device
            .as_deref()
            .filter(|token| device_nonce(secret, &input.email, token).is_some());
        let limits = login_limits(secret, &input.email, device, context.client);
        self.state.auth.rate_limits(&self.state.db, &limits).await?;
        let deadline = context.arrived.unwrap_or_else(tokio::time::Instant::now)
            + self.state.config.sign_in_answer;
        let Some(session) = self
            .state
            .auth
            .login(&self.state.db, &input, deadline)
            .await?
        else {
            context.answer_not_before.get_or_init(|| deadline);
            return Err(ApiError::credentials());
        };
        let device = device.map_or_else(|| device_token(secret, &input.email), str::to_owned);
        Ok((session, self.device_cookie(&device)))
    }
    fn device_cookie(&self, token: &str) -> String {
        format!(
            "{DEVICE_COOKIE}={token}; Path=/api/rpc; HttpOnly; SameSite=Strict; Max-Age={DEVICE_SECONDS}{}",
            if self.state.config.secure_cookies {
                "; Secure"
            } else {
                ""
            }
        )
    }
    pub async fn logout(&self, token: Option<&str>) -> Result<Done, ApiError> {
        let tx = Arc::new(begin(&self.state.db).await?);
        self.state.auth.logout(tx.clone(), token).await?;
        commit(tx).await?;
        Ok(Done { success: true })
    }
    pub async fn accept_invite(
        &self,
        mut input: AcceptInvite,
        context: &RequestContext,
    ) -> Result<IssuedSession, ApiError> {
        let scope = format!("invite:{}", digest(&input.token));
        let limits = crate::auth::secret_limits(&scope, context.client);
        self.state.auth.rate_limits(&self.state.db, &limits).await?;
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
                crate::auth::SECRET_ATTEMPTS,
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
/// Attempts per 15-minute window for one email from one device or client address.
const LOGIN_ATTEMPTS: i32 = 10;
/// Attempts per window from one directly connected client address, across all emails.
const LOGIN_ATTEMPTS_PER_ADDRESS: i32 = 100;
const DEVICE_SECONDS: i64 = 180 * 24 * 60 * 60;

/// Which counters a login attempt consumes. A browser that has signed in to this email before
/// presents a MAC-bound device cookie and gets its own budget, so strangers' failures cannot lock
/// it out. Other attempts are keyed per email and client address (see `rpc::client_address`),
/// with a per-client ceiling across emails. With no known client (behind a web host that is not a
/// listed proxy) those attempts share one per-email budget and no per-client limit applies.
fn login_limits(
    secret: &str,
    email: &str,
    device: Option<&str>,
    client: Option<IpAddr>,
) -> Vec<(String, i32)> {
    if let Some(nonce) = device.and_then(|token| device_nonce(secret, email, token)) {
        return vec![(format!("login-device:{email}:{nonce}"), LOGIN_ATTEMPTS)];
    }
    match client.map(crate::rpc::client_key) {
        Some(client) => vec![
            (format!("login:{email}:{client}"), LOGIN_ATTEMPTS),
            (
                format!("login-address:{client}"),
                LOGIN_ATTEMPTS_PER_ADDRESS,
            ),
        ],
        None => vec![(format!("login:{email}"), LOGIN_ATTEMPTS)],
    }
}
fn device_token(secret: &str, email: &str) -> String {
    let nonce = random_token();
    let mac = device_mac(secret, email, &nonce);
    format!("{nonce}.{mac}")
}
/// The nonce of a device token minted for this email by this server, if the MAC verifies.
fn device_nonce<'a>(secret: &str, email: &str, token: &'a str) -> Option<&'a str> {
    let (nonce, mac) = token.split_once('.')?;
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    bool::from(
        device_mac(secret, email, nonce)
            .as_bytes()
            .ct_eq(mac.as_bytes()),
    )
    .then_some(nonce)
}
fn device_mac(secret: &str, email: &str, nonce: &str) -> String {
    // Domain-separated from every other use of the auth secret.
    let message = format!("hyori-login-device-v1\0{email}\0{nonce}");
    hex::encode(hmac_sha256(secret.as_bytes(), message.as_bytes()))
}
/// HMAC-SHA-256 (RFC 2104).
fn hmac_sha256(secret: &[u8], message: &[u8]) -> [u8; 32] {
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

#[cfg(test)]
mod tests {
    use super::*;
    const SECRET: &str = "test-secret-with-at-least-thirty-two-bytes";
    #[test]
    fn hmac_matches_rfc_4231_test_case_two() {
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
    #[test]
    fn device_tokens_verify_only_for_their_email_and_secret() {
        let token = device_token(SECRET, "user@example.test");
        assert!(device_nonce(SECRET, "user@example.test", &token).is_some());
        assert!(device_nonce(SECRET, "other@example.test", &token).is_none());
        assert!(
            device_nonce(
                "another-secret-of-thirty-two-bytes!!",
                "user@example.test",
                &token
            )
            .is_none()
        );
        let forged = format!("{}.{}", random_token(), random_token());
        assert!(device_nonce(SECRET, "user@example.test", &forged).is_none());
    }
    #[test]
    fn a_known_device_has_its_own_budget_independent_of_the_email_lockout() {
        let token = device_token(SECRET, "user@example.test");
        let known = login_limits(SECRET, "user@example.test", Some(&token), None);
        let unknown = login_limits(SECRET, "user@example.test", None, None);
        assert_eq!(known.len(), 1);
        assert!(known[0].0.starts_with("login-device:user@example.test:"));
        assert_eq!(
            unknown,
            vec![("login:user@example.test".into(), LOGIN_ATTEMPTS)]
        );
    }
    #[test]
    fn only_direct_client_addresses_key_attempts_by_address() {
        let public: IpAddr = "203.0.113.7".parse().unwrap();
        assert_eq!(
            login_limits(SECRET, "u@example.test", None, Some(public)),
            vec![
                ("login:u@example.test:203.0.113.7".into(), LOGIN_ATTEMPTS),
                (
                    "login-address:203.0.113.7".into(),
                    LOGIN_ATTEMPTS_PER_ADDRESS
                ),
            ]
        );
        for proxy in [
            "127.0.0.1",
            "10.0.0.2",
            "172.18.0.3",
            "::1",
            "fd00::1",
            "::ffff:192.168.1.2",
        ] {
            let proxy: IpAddr = proxy.parse().unwrap();
            let client = crate::rpc::client_address(&Default::default(), Some(proxy), &[]);
            assert_eq!(
                login_limits(SECRET, "u@example.test", None, client).len(),
                1,
                "{proxy}"
            );
        }
    }
}

use crate::{
    AppState,
    auth::{digest, random_token},
    db::{self, sql},
    error::ApiError,
    features::{
        auth::api::Done,
        files::{
            policy::{self, Action},
            service::FilesService,
        },
        shares::{
            api::*,
            capability::{self, Capability},
            db::ShareRecord,
        },
    },
    rpc::{GRANT_COOKIE_PREFIX, RequestContext, RpcResult},
    wire::Nullable,
};
use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use std::sync::Arc;

/// Each share has an independent host-only cookie, so concurrent responses from different
/// processes/tabs merge by name even from an empty jar. Resolving with a live credential preserves it
/// credential and original expiry so anonymous upload initiators survive reloads and other tabs.
/// Only when the observed jar plus the new name exceeds 16 cookies do resolves evict names outside
/// the newest 16 DB-validated shares. Below capacity, even expired names are left alone: a parallel
/// response may be refreshing them. Concurrent additions at capacity can temporarily leave more
/// than 16 cookies; policy still admits only 16, and the next resolve reconciles the jar.
/// Each cookie holds a signed capability (see `capability`), so opening a link stores nothing;
/// expiring a browser cookie does not revoke a copy of the capability held elsewhere.
fn grant_cookie(name: &str, token: &str, secure: bool, remaining_seconds: i64) -> String {
    format!(
        "{name}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        if token.is_empty() {
            0
        } else {
            remaining_seconds
        },
        if secure { "; Secure" } else { "" }
    )
}

pub(crate) struct SharesService {
    state: Arc<AppState>,
    context: RequestContext,
}
impl SharesService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            state: state.clone(),
            context,
        }
    }
    fn files(&self) -> FilesService {
        FilesService::new(&self.state, self.context.clone())
    }
    pub async fn list(&self, input: SharesListInput) -> Result<SharesList, ApiError> {
        self.files()
            .run(move |tx, actor| {
                let input = input.clone();
                Box::pin(async move {
                    policy::authorize(tx, &actor, &input.item_id.0, Action::Owner, false).await?;
                    let items = tx
                        .query_all_raw(sql(
                            "SELECT * FROM hyori_shares WHERE item_id=$1 AND revoked_at IS NULL
                 ORDER BY id LIMIT 100",
                            vec![input.item_id.0.into()],
                        ))
                        .await?
                        .into_iter()
                        .map(|row| ShareRecord::from_row(row).map(|s| s.project(None)))
                        .collect::<db::DomainResult<_>>()?;
                    Ok(SharesList { items })
                })
            })
            .await
    }
    pub async fn create(&self, input: CreateShare) -> Result<Share, ApiError> {
        let item_id = input.item_id.0.clone();
        // Avoid spending KDF capacity for callers that cannot issue shares. Reauthorize after KDF.
        self.files()
            .run(move |tx, actor| {
                let id = item_id.clone();
                Box::pin(async move {
                    policy::authorize(tx, &actor, &id, Action::Owner, false).await?;
                    Ok(())
                })
            })
            .await?;
        let recipient_id = input.recipient_id.and_then(|r| r.0).map(|r| r.0);
        if input.public == recipient_id.is_some() || (!input.public && input.password.is_some()) {
            return Err(ApiError::invalid());
        }
        let expiry = input
            .expires_at
            .and_then(|e| e.0)
            .map(|t| t.parse())
            .transpose()?;
        if expiry.is_some_and(|expiry| expiry <= Utc::now()) {
            return Err(ApiError::invalid());
        }
        let password_hash = if let Some(password) = input.password {
            Some(self.state.auth.hash_link_password(&password).await?)
        } else {
            None
        };
        let token = input.public.then(random_token);
        let origin = self.state.config.origin.clone();
        self.files().run(move |tx, actor| {
            let id = input.item_id.0.clone(); let role = input.role.clone(); let recipient_id = recipient_id.clone(); let password_hash = password_hash.clone(); let token = token.clone(); let origin = origin.clone();
            Box::pin(async move {
                let item = policy::authorize(tx, &actor, &id, Action::Owner, false).await?;
                if expiry.is_some_and(|expiry| expiry <= Utc::now()) { return Err(ApiError::invalid().into()); }
                if let Some(recipient) = &recipient_id
                    && (recipient == &item.owner_id || tx.query_one_raw(sql("SELECT id FROM hyori_users WHERE id=$1 AND status='active'", vec![recipient.clone().into()])).await?.is_none()) {
                    return Err(ApiError::invalid().into());
                }
                let existing = tx.query_all_raw(sql("SELECT recipient_id FROM hyori_shares WHERE item_id=$1 AND revoked_at IS NULL
                 ORDER BY id LIMIT 100", vec![id.clone().into()])).await?;
                if existing.len() >= 100 { return Err(ApiError::conflict().into()); }
                if let Some(recipient) = &recipient_id {
                    for row in existing { if row.try_get::<Option<String>>("", "recipient_id")?.as_ref() == Some(recipient) { return Err(ApiError::conflict().into()); } }
                }
                let share = ShareRecord {id: random_token(), item_id: id, issuer_id: item.owner_id, recipient_id, public: input.public, role, token_digest: token.as_deref().map(digest), password_hash, expires_at: expiry, revoked_at: None};
                share.insert(tx).await?;
                Ok(share.project(token.map(|token| format!("{origin}/share/{token}"))))
            })
        }).await
    }
    pub async fn revoke(&self, input: ShareInput) -> Result<Done, ApiError> {
        self.files()
            .run(move |tx, actor| {
                let input = input.clone();
                Box::pin(async move {
                    let share = ShareRecord::get(tx, &input.id.0).await?;
                    policy::authorize(tx, &actor, &share.item_id, Action::Owner, true).await?;
                    tx.execute_raw(sql(
                        "UPDATE hyori_shares SET revoked_at=now() WHERE id=$1",
                        vec![input.id.0.into()],
                    ))
                    .await?;
                    Ok(Done { success: true })
                })
            })
            .await
    }
    pub async fn resolve(&self, input: ResolveShare) -> Result<RpcResult<ResolvedShare>, ApiError> {
        self.resolve_token(input.token, None).await
    }
    pub async fn unlock(&self, input: UnlockShare) -> Result<RpcResult<ResolvedShare>, ApiError> {
        let scope = format!("share:{}", digest(&input.token));
        let limits = crate::auth::secret_limits(&scope, self.context.client);
        self.state.auth.rate_limits(&self.state.db, &limits).await?;
        self.resolve_token(input.token, Some(input.password)).await
    }
    async fn resolve_token(
        &self,
        token: String,
        password: Option<String>,
    ) -> Result<RpcResult<ResolvedShare>, ApiError> {
        let token_digest = digest(&token);
        let lookup = token_digest.clone();
        let candidate = db::domain(&self.state.db, move |tx| {
            let lookup = lookup.clone();
            Box::pin(async move { ShareRecord::by_token(tx, &lookup).await })
        })
        .await?;
        let password_valid =
            if let (Some(hash), Some(password)) = (&candidate.password_hash, &password) {
                self.state.auth.verify_link_password(hash, password).await?
            } else {
                false
            };
        if password.is_some() && candidate.password_hash.is_some() && !password_valid {
            return Err(ApiError::denied());
        }
        let cookie_name = format!("{GRANT_COOKIE_PREFIX}{}", candidate.id);
        let credentials = self.context.grants.clone();
        let key = capability::key(&self.state.config.auth_secret);
        // Reads only: opening a link stores nothing, so concurrent opens never conflict.
        let result = self
            .files()
            .run(move |tx, actor| {
                let token_digest = token_digest.clone();
                let hash = candidate.password_hash.clone();
                let credentials = credentials.clone();
                Box::pin(async move {
                    let share = ShareRecord::by_token(tx, &token_digest).await?;
                    // A future password-change operation cannot make an old KDF verification usable.
                    if share.password_hash != hash {
                        return Err(ApiError::denied().into());
                    }
                    let existing = held_credential(tx, &key, &share, &credentials).await?;
                    if share.password_hash.is_some() && !password_valid && existing.is_none() {
                        return Ok((
                            ResolvedShare {
                                share: share.project(None),
                                item: Nullable(None),
                                requires_password: true,
                            },
                            vec![],
                            None,
                        ));
                    }
                    let actor = actor.with_share(share.id.clone());
                    let item =
                        policy::authorize(tx, &actor, &share.item_id, Action::Read, false).await?;
                    // A visitor who already holds a live credential keeps it, and with it their
                    // uploads and editor handles; anyone else gets a new capability.
                    let grant = existing.unwrap_or_else(|| {
                        capability::issue(
                            &key,
                            &share.id,
                            share.password_hash.as_deref(),
                            share.expires_at,
                        )
                    });
                    Ok((
                        ResolvedShare {
                            share: share.project(None),
                            item: Nullable(Some(policy::project(&item, &actor))),
                            requires_password: false,
                        },
                        actor.public_shares().to_vec(),
                        Some(grant),
                    ))
                })
            })
            .await?;
        let (value, retained, grant) = result;
        if value.requires_password {
            return Ok(RpcResult::value(value));
        }
        let (token, remaining) = grant.ok_or_else(ApiError::unavailable)?;
        let mut cookies = vec![grant_cookie(
            &cookie_name,
            &token,
            self.state.config.secure_cookies,
            remaining,
        )];
        let observed_count = self
            .context
            .grant_cookie_names
            .iter()
            .filter(|name| name.starts_with(GRANT_COOKIE_PREFIX) && **name != cookie_name)
            .count()
            + 1;
        if observed_count > 16 {
            for name in &self.context.grant_cookie_names {
                if let Some(id) = name.strip_prefix(GRANT_COOKIE_PREFIX)
                    && !retained.iter().any(|share| share == id)
                {
                    cookies.push(grant_cookie(name, "", self.state.config.secure_cookies, 0));
                }
            }
        }
        Ok(RpcResult { value, cookies })
    }
}
/// A live credential for `share` among the visitor's, with its remaining seconds: a capability
/// issued for the link as it is now, or a grant stored before capabilities.
async fn held_credential(
    tx: &DatabaseTransaction,
    key: &[u8; 32],
    share: &ShareRecord,
    credentials: &[String],
) -> db::DomainResult<Option<(String, i64)>> {
    let now = Utc::now();
    let capability = credentials
        .iter()
        .filter_map(|token| Capability::parse(token).map(|parsed| (token, parsed)))
        .filter(|(_, parsed)| {
            parsed.share_id == share.id
                && parsed.live(now)
                && parsed.verifies(key, share.password_hash.as_deref())
        })
        .max_by_key(|(_, parsed)| parsed.expires);
    if let Some((token, parsed)) = capability {
        return Ok(Some((
            token.clone(),
            (parsed.expires - now.timestamp()).max(1),
        )));
    }
    let digests: Vec<_> = credentials
        .iter()
        .filter(|token| crate::rpc::valid_token(token))
        .map(|token| digest(token))
        .collect();
    if digests.is_empty() {
        return Ok(None);
    }
    let Some(row) = tx
        .query_one_raw(sql(
            "SELECT token_digest, GREATEST(1,ceil(extract(epoch FROM (expires_at-now()))))::bigint AS remaining
             FROM hyori_grants WHERE share_id=$1
             AND token_digest IN (SELECT jsonb_array_elements_text($2::jsonb))
             AND expires_at>now() ORDER BY created_at DESC,token_digest LIMIT 1",
            vec![share.id.clone().into(), serde_json::json!(digests).into()],
        ))
        .await?
    else {
        return Ok(None);
    };
    let stored = row.try_get::<String>("", "token_digest")?;
    let token = credentials
        .iter()
        .find(|token| digest(token) == stored)
        .ok_or_else(ApiError::unavailable)?;
    Ok(Some((token.clone(), row.try_get("", "remaining")?)))
}

use crate::features::shares::capability::Capability;
use crate::{
    auth::digest,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Bytes, Id, Name},
        files::{
            api::{Access, FileEntry, FileKind, ShareRole},
            db::Item,
        },
    },
    rpc::RequestContext,
    wire::Nullable,
};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use unicode_normalization::UnicodeNormalization;

/// Transaction-local identity and at most 16 current public links, newest first.
/// Direct recipient shares are resolved only against resources, never enumerated here.
#[derive(Clone)]
pub(crate) struct ProductActor {
    user_id: Option<String>,
    public_shares: Vec<String>,
    /// When the last of the link credentials behind `public_shares` expires.
    link_expiry: Option<DateTime<Utc>>,
}
impl ProductActor {
    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }
    pub fn require_user(&self) -> DomainResult<&str> {
        self.user_id().ok_or_else(|| ApiError::required().into())
    }
    pub fn public_shares(&self) -> &[String] {
        &self.public_shares
    }
    pub fn link_expiry(&self) -> Option<DateTime<Utc>> {
        self.link_expiry
    }
    pub fn with_share(mut self, id: String) -> Self {
        self.public_shares.retain(|share| share != &id);
        self.public_shares.truncate(15);
        self.public_shares.insert(0, id);
        self
    }
    pub fn require_access(&self) -> DomainResult<()> {
        if self.user_id.is_none() && self.public_shares.is_empty() {
            return Err(ApiError::required().into());
        }
        Ok(())
    }
}

/// Live link credentials the shares are current for: the share id, when the credential was
/// issued (newest wins) and when it expires.
type LinkCredential = (String, DateTime<Utc>, DateTime<Utc>);

/// Resolve identity and at most 16 active public shares in the supplied serializable transaction.
/// The parser bounds candidate credentials; issue time determines retention, not cookie
/// names/order. No admin flag is read. Revoked or expired links and deleted issuers invalidate
/// credentials immediately, whether they are capabilities or stored grants.
/// Account KEY SHARE still blocks deletion's explicit FOR UPDATE barrier while allowing non-key
/// quota updates; SHARE would force parallel uploads into lock-upgrade deadlocks.
pub(crate) async fn resolve_actor(
    tx: &DatabaseTransaction,
    context: &RequestContext,
) -> DomainResult<ProductActor> {
    let user_id = if let Some(token) = &context.session {
        tx.query_one_raw(sql("SELECT u.id FROM hyori_sessions s JOIN hyori_users u ON u.id=s.user_id WHERE s.token_digest=$1 AND s.expires_at>now() AND u.status='active' FOR SHARE OF s FOR KEY SHARE OF u", vec![digest(token).into()])).await?.map(|row| row.try_get::<String>("", "id")).transpose()?
    } else {
        None
    };
    let candidates = &context.grants[..context.grants.len().min(crate::rpc::MAX_GRANT_CANDIDATES)];
    let mut live = stored_grants(tx, candidates).await?;
    if let Some(key) = &context.capability_key {
        live.extend(capabilities(tx, key, candidates).await?);
    }
    live.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut public_shares: Vec<String> = Vec::new();
    let mut link_expiry = None;
    for (share, _, expires) in live {
        if public_shares.contains(&share) {
            continue;
        }
        if public_shares.len() == 16 {
            break;
        }
        public_shares.push(share);
        link_expiry = link_expiry.max(Some(expires));
    }
    Ok(ProductActor {
        user_id,
        public_shares,
        link_expiry,
    })
}
/// Grants stored before link capabilities existed, valid until their 12 hours end.
async fn stored_grants(
    tx: &DatabaseTransaction,
    candidates: &[String],
) -> DomainResult<Vec<LinkCredential>> {
    let digests: Vec<_> = candidates
        .iter()
        .filter(|token| crate::rpc::valid_token(token))
        .map(|token| digest(token))
        .collect();
    if digests.is_empty() {
        return Ok(vec![]);
    }
    tx.query_all_raw(sql(
        "SELECT s.id, max(g.created_at) AS issued, max(g.expires_at) AS expires FROM hyori_grants g
         JOIN hyori_shares s ON s.id=g.share_id
         JOIN hyori_users u ON u.id=s.issuer_id
         WHERE g.token_digest IN (SELECT jsonb_array_elements_text($1::jsonb))
           AND g.expires_at>now() AND s.public AND s.revoked_at IS NULL
           AND (s.expires_at IS NULL OR s.expires_at>now()) AND u.status='active'
         GROUP BY s.id",
        vec![serde_json::json!(digests).into()],
    ))
    .await?
    .into_iter()
    .map(|row| {
        Ok((
            row.try_get("", "id")?,
            row.try_get("", "issued")?,
            row.try_get("", "expires")?,
        ))
    })
    .collect()
}
/// Capabilities whose MAC verifies against their link as it is now, password included.
async fn capabilities(
    tx: &DatabaseTransaction,
    key: &[u8; 32],
    candidates: &[String],
) -> DomainResult<Vec<LinkCredential>> {
    let now = Utc::now();
    let parsed: Vec<_> = candidates
        .iter()
        .filter_map(|token| Capability::parse(token))
        .filter(|capability| capability.live(now))
        .collect();
    if parsed.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<_> = parsed
        .iter()
        .map(|capability| capability.share_id)
        .collect();
    let shares = tx
        .query_all_raw(sql(
            "SELECT s.id,s.password_hash FROM hyori_shares s JOIN hyori_users u ON u.id=s.issuer_id
             WHERE s.id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND s.public
               AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
               AND u.status='active'",
            vec![serde_json::json!(ids).into()],
        ))
        .await?
        .into_iter()
        .map(|row| Ok((row.try_get("", "id")?, row.try_get("", "password_hash")?)))
        .collect::<DomainResult<Vec<(String, Option<String>)>>>()?;
    Ok(parsed
        .into_iter()
        .filter_map(|capability| {
            let (_, hash) = shares.iter().find(|(id, _)| id == capability.share_id)?;
            capability.verifies(key, hash.as_deref()).then(|| {
                (
                    capability.share_id.to_owned(),
                    capability.issued_at(),
                    capability.expires_at(),
                )
            })
        })
        .collect())
}
pub(crate) fn parse_role(value: &str) -> DomainResult<ShareRole> {
    match value {
        "viewer" => Ok(ShareRole::Viewer),
        "contributor" => Ok(ShareRole::Contributor),
        "editor" => Ok(ShareRole::Editor),
        _ => Err(ApiError::unavailable().into()),
    }
}
pub(crate) fn role_name(role: &ShareRole) -> &'static str {
    match role {
        ShareRole::Viewer => "viewer",
        ShareRole::Contributor => "contributor",
        ShareRole::Editor => "editor",
    }
}
/// Aggregate effective roles for a bounded metadata page (or one resource), in one SQL request.
/// Each resource contributes at most 64 indexed share roots; only one aggregate row per resource
/// crosses the DB boundary, regardless of recipient count, owners, or overlapping grants.
/// Call again after changing ancestry; never carry these roles across transactions.
pub(crate) async fn load_roles(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    items: &mut [Item],
) -> DomainResult<()> {
    let scopes: Vec<_> = items
        .iter()
        .filter(|item| item.trashed_at.is_none())
        .map(|item| {
            let mut roots = item.ancestor_ids.clone();
            roots.push(item.id.clone());
            serde_json::json!({"id": item.id, "roots": roots})
        })
        .collect();
    if scopes.is_empty() {
        return Ok(());
    }
    let roles = tx.query_all_raw(sql(
        "SELECT scope.id, max(CASE s.role WHEN 'editor' THEN 3 WHEN 'contributor' THEN 2 ELSE 1 END) AS rank,
                bool_or(s.item_id<>scope.id) AS parent_readable
         FROM jsonb_to_recordset($3::jsonb) AS scope(id text, roots jsonb)
         CROSS JOIN LATERAL jsonb_array_elements_text(scope.roots) AS root(id)
         JOIN hyori_shares s ON s.item_id=root.id AND s.revoked_at IS NULL
         JOIN hyori_users u ON u.id=s.issuer_id AND u.status='active'
         WHERE (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb))))
           AND (s.expires_at IS NULL OR s.expires_at>now())
         GROUP BY scope.id",
        vec![actor.user_id().into(), serde_json::json!(actor.public_shares()).into(), serde_json::json!(scopes).into()],
    )).await?.into_iter().map(|row| {
        let role = match row.try_get::<i32>("", "rank")? {
            3 => ShareRole::Editor,
            2 => ShareRole::Contributor,
            _ => ShareRole::Viewer,
        };
        Ok((row.try_get::<String>("", "id")?, (role, row.try_get::<bool>("", "parent_readable")?)))
    }).collect::<Result<std::collections::HashMap<_, _>, sea_orm::DbErr>>()?;
    for item in items {
        item.share_role = roles.get(&item.id).map(|(role, _)| role.clone());
        item.parent_readable = roles.get(&item.id).is_some_and(|(_, readable)| *readable);
    }
    Ok(())
}
/// SQL selecting the item IDs at which the actor's current direct and public shares are rooted,
/// given the actor and public-grant parameter placeholders. Direct shares come through the
/// recipient index and public ones by share ID, never through a scan of every account's shares.
/// Consumers use membership (ANY or ?|), so duplicate roots need no sort/deduplication here.
pub(crate) fn eligible_share_roots(actor: &str, grants: &str) -> String {
    let current = "s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())";
    let issuer = "JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'";
    format!(
        "SELECT s.item_id FROM hyori_shares s {issuer} WHERE s.recipient_id={actor} AND {current}
        UNION ALL SELECT s.item_id FROM hyori_shares s {issuer}
        WHERE s.public AND s.id IN (SELECT jsonb_array_elements_text({grants}::jsonb)) AND {current}"
    )
}
pub(crate) fn access(item: &Item, actor: &ProductActor) -> Access {
    let is_owner = actor.user_id() == Some(item.owner_id.as_str());
    let role = if item.trashed_at.is_some() {
        None
    } else {
        item.share_role.clone()
    };
    Access {
        can_download: is_owner || role.is_some(),
        can_upload: item.trashed_at.is_none()
            && item.kind == FileKind::Folder
            && (is_owner || matches!(role, Some(ShareRole::Contributor | ShareRole::Editor))),
        can_edit: item.trashed_at.is_none() && (is_owner || role == Some(ShareRole::Editor)),
        can_rename: item.trashed_at.is_none()
            && (is_owner || (role == Some(ShareRole::Editor) && item.parent_readable)),
        can_delete: is_owner,
        can_share: is_owner && item.trashed_at.is_none(),
        is_owner,
        role: Nullable(role),
    }
}
pub(crate) fn project(item: &Item, actor: &ProductActor) -> FileEntry {
    FileEntry {
        id: Id(item.id.clone()),
        name: Name(item.name.clone()),
        kind: item.kind.clone(),
        parent_id: Nullable(item.parent_id.clone().map(Id)),
        owner_id: Id(item.owner_id.clone()),
        size: Bytes(item.size as u64),
        mime_type: item.mime_type.clone(),
        created_at: item.created_at.to_rfc3339(),
        updated_at: item.updated_at.to_rfc3339(),
        trashed_at: Nullable(item.trashed_at.map(|t| t.to_rfc3339())),
        access: access(item, actor),
    }
}
#[derive(Clone, Copy)]
pub(crate) enum Action {
    Read,
    Edit,
    Rename,
    Upload,
    Owner,
}
/// All feature owners must authorize in the same transaction that reads/mutates metadata.
pub(crate) async fn authorize(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    id: &str,
    action: Action,
    allow_trash: bool,
) -> DomainResult<Item> {
    let mut item = Item::get(tx, id).await?;
    if item.trashed_at.is_some() && !allow_trash {
        return Err(ApiError::not_found().into());
    }
    if tx
        .query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
            vec![item.owner_id.clone().into()],
        ))
        .await?
        .is_none()
    {
        return Err(ApiError::not_found().into());
    }
    // No amount of sharing can authorize an owner-only operation.
    if matches!(action, Action::Owner) && actor.user_id() != Some(item.owner_id.as_str()) {
        return Err(ApiError::denied().into());
    }
    load_roles(tx, actor, std::slice::from_mut(&mut item)).await?;
    let access = access(&item, actor);
    if !match action {
        Action::Read => access.can_download,
        Action::Edit => access.can_edit,
        Action::Rename => access.can_rename,
        Action::Upload => access.can_upload,
        Action::Owner => access.is_owner,
    } {
        return Err(ApiError::denied().into());
    }
    Ok(item)
}
pub(crate) struct Destination {
    pub owner_id: String,
    pub parent: Option<Item>,
    pub ancestor_ids: Vec<String>,
}
pub(crate) async fn destination(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    parent_id: Option<&str>,
) -> DomainResult<Destination> {
    if let Some(id) = parent_id {
        let parent = authorize(tx, actor, id, Action::Upload, false).await?;
        if parent.kind != FileKind::Folder || parent.ancestor_ids.len() >= 63 {
            return Err(ApiError::invalid().into());
        }
        let mut ancestor_ids = parent.ancestor_ids.clone();
        ancestor_ids.push(parent.id.clone());
        Ok(Destination {
            owner_id: parent.owner_id.clone(),
            parent: Some(parent),
            ancestor_ids,
        })
    } else {
        Ok(Destination {
            owner_id: actor.require_user()?.into(),
            parent: None,
            ancestor_ids: vec![],
        })
    }
}
pub(crate) fn normalize_name(name: &str) -> Result<String, ApiError> {
    let name: String = name.trim().nfc().collect();
    if name.is_empty()
        || name.chars().count() > 255
        || name == "."
        || name == ".."
        || name.chars().any(|c| c < ' ' || c == '/' || c == '\\')
    {
        return Err(ApiError::invalid());
    }
    Ok(name)
}
pub(crate) async fn available_name(
    tx: &DatabaseTransaction,
    owner_id: &str,
    parent_id: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> DomainResult<()> {
    if tx.query_one_raw(sql("SELECT id FROM hyori_items WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND trashed_at IS NULL AND id<>$4 LIMIT 1", vec![owner_id.into(), parent_id.into(), name.into(), except.unwrap_or("").into()])).await?.is_some() { return Err(ApiError::conflict().into()); }
    Ok(())
}
/// IDs are opaque stable keysets, matching the existing client contract (not offsets).
pub(crate) fn cursor(cursor: Option<&str>) -> Result<&str, ApiError> {
    let cursor = cursor.unwrap_or("");
    if cursor.len() > 128
        || !cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ApiError::invalid());
    }
    Ok(cursor)
}

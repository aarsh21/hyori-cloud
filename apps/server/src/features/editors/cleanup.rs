//! Bounded editor retention. Exact-key upload inventory outlives sensitive session/save metadata.
use crate::{
    db::{self, DomainResult, sql},
    error::ApiError,
    features::{shares::capability::Capability, uploads::db::Upload},
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction};

/// Sessions removed per maintenance pass, matching `remove`'s save batch.
const BATCH: usize = 256;
/// Each principal's open handles for one source owner.
const PER_PRINCIPAL: i64 = 32;
/// Everyone except the owner, who keeps their own `PER_PRINCIPAL` handles in reserve.
const SHARED: i64 = 256;
/// Public-link holders can mint fresh grants, so they share a smaller part of `SHARED`.
const ANONYMOUS: i64 = 128;
/// A link session has ended for good once its credentials have expired or none of its links is
/// live: revocation is final and a credential's expiry is fixed when it is issued, so no later
/// request can authorize it again. Sessions opened through link capabilities record their links
/// and that expiry; older ones are judged by their stored grants.
const LINK_ENDED: &str = "s.initiator_id IS NULL AND CASE WHEN s.link_expires_at IS NULL THEN NOT EXISTS (SELECT 1 FROM hyori_grants g JOIN hyori_shares sh ON sh.id=g.share_id WHERE g.token_digest IN (SELECT jsonb_array_elements_text(s.grant_digests)) AND g.expires_at>now() AND sh.public AND sh.revoked_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>now())) ELSE s.link_expires_at<=now() OR NOT EXISTS (SELECT 1 FROM hyori_shares sh WHERE sh.id IN (SELECT jsonb_array_elements_text(s.link_shares)) AND sh.public AND sh.revoked_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at>now())) END";
/// A save without a durable outcome may still publish; nothing but close, expiry or a dead link ends it.
const IDLE: &str =
    "NOT EXISTS (SELECT 1 FROM hyori_editor_saves v WHERE v.session_id=s.id AND v.result IS NULL)";

pub async fn run_once(connection: &DatabaseConnection) -> Result<(), ApiError> {
    db::domain(connection, |tx| Box::pin(async move {
        let sessions = tx.query_all_raw(sql("SELECT id FROM hyori_editor_sessions WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 256 FOR UPDATE SKIP LOCKED",vec![])).await?;
        let mut ids: Vec<String> = sessions.into_iter().map(|row| row.try_get("","id")).collect::<Result<_,_>>()?;
        // Their unfinished saves can never publish again; aborting them releases the reservation.
        let ended = tx.query_all_raw(sql(&format!("SELECT id FROM hyori_editor_sessions s WHERE expires_at>now() AND {LINK_ENDED} ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED"),vec![(BATCH.saturating_sub(ids.len()) as i64).into()])).await?;
        for row in ended {
            ids.push(row.try_get("", "id")?);
        }
        remove(tx,&ids).await
    })).await
}
/// Admission for one source owner, whose row the caller holds locked. Sessions that have ended are
/// dropped first; if a shared budget is still full, the opener's pool gives up its least recently
/// active idle sessions. The owner's own reserve is never used by others or evicted for them.
pub(crate) async fn admit(
    tx: &DatabaseTransaction,
    owner: &str,
    principal: &str,
    user: Option<&str>,
) -> DomainResult<()> {
    let ended = tx.query_all_raw(sql(&format!("SELECT id FROM hyori_editor_sessions s WHERE owner_id=$1 AND (expires_at<=now() OR {LINK_ENDED}) AND {IDLE} ORDER BY created_at,id LIMIT 32"),vec![owner.into()])).await?;
    evict(tx, ended).await?;
    let counts = tx.query_one_raw(sql("SELECT count(*) FILTER (WHERE principal=$2) AS mine, count(*) FILTER (WHERE initiator_id IS DISTINCT FROM $1) AS shared, count(*) FILTER (WHERE initiator_id IS NULL) AS anonymous FROM hyori_editor_sessions WHERE owner_id=$1",vec![owner.into(),principal.into()])).await?.ok_or_else(ApiError::unavailable)?;
    if counts.try_get::<i64>("", "mine")? >= PER_PRINCIPAL {
        return Err(ApiError::new(
            crate::error::ErrorCode::Conflict,
            "Too many documents are open for this person; close one and try again",
        )
        .into());
    }
    if user == Some(owner) {
        return Ok(());
    }
    let mut excess = counts.try_get::<i64>("", "shared")? - SHARED + 1;
    // Link holders can only displace each other, never signed-in collaborators.
    let pool = if user.is_none() {
        excess = excess.max(counts.try_get::<i64>("", "anonymous")? - ANONYMOUS + 1);
        "s.initiator_id IS NULL"
    } else {
        "s.initiator_id IS DISTINCT FROM $1"
    };
    if excess <= 0 {
        return Ok(());
    }
    let idle = tx.query_all_raw(sql(&format!("SELECT s.id FROM hyori_editor_sessions s WHERE s.owner_id=$1 AND {pool} AND {IDLE} ORDER BY GREATEST(s.created_at,(SELECT max(u.created_at) FROM hyori_editor_saves v JOIN hyori_uploads u ON u.id=v.upload_id WHERE v.session_id=s.id)),s.id LIMIT $2"),vec![owner.into(),excess.into()])).await?;
    if (idle.len() as i64) < excess {
        return Err(ApiError::new(
            crate::error::ErrorCode::Conflict,
            "Too many of this owner's documents are open; close one and try again",
        )
        .into());
    }
    evict(tx, idle).await
}
/// Removes sessions selected as idle in this serializable snapshot. Their saves all have durable
/// outcomes, so no upload needs aborting; a save admitted concurrently keeps its session.
async fn evict(tx: &DatabaseTransaction, rows: Vec<sea_orm::QueryResult>) -> DomainResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids = serde_json::json!(
        rows.into_iter()
            .map(|row| row.try_get::<String>("", "id"))
            .collect::<Result<Vec<_>, _>>()?
    );
    tx.execute_raw(sql("DELETE FROM hyori_editor_saves WHERE session_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND result IS NOT NULL",vec![ids.clone().into()])).await?;
    tx.execute_raw(sql("DELETE FROM hyori_editor_sessions s WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND NOT EXISTS (SELECT 1 FROM hyori_editor_saves v WHERE v.session_id=s.id)",vec![ids.into()])).await?;
    Ok(())
}
pub(crate) async fn purge(tx: &DatabaseTransaction, user: &str) -> DomainResult<()> {
    let sessions = tx.query_all_raw(sql("SELECT id FROM hyori_editor_sessions WHERE owner_id=$1 OR initiator_id=$1 OR id IN (SELECT session_id FROM hyori_editor_saves WHERE destination_owner_id=$1 ORDER BY upload_id LIMIT 256) ORDER BY id LIMIT 256",vec![user.into()])).await?;
    let ids: Vec<String> = sessions
        .into_iter()
        .map(|row| row.try_get("", "id"))
        .collect::<Result<_, _>>()?;
    tx.execute_raw(sql("UPDATE hyori_editor_sessions SET expires_at=LEAST(expires_at,now()) WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",vec![serde_json::json!(ids).into()])).await?;
    remove(tx, &ids).await
}
pub(crate) async fn purge_pending(tx: &DatabaseTransaction, user: &str) -> DomainResult<bool> {
    let row = tx.query_one_raw(sql("SELECT EXISTS(SELECT 1 FROM hyori_editor_sessions WHERE owner_id=$1 OR initiator_id=$1) OR EXISTS(SELECT 1 FROM hyori_editor_saves WHERE destination_owner_id=$1) AS pending",vec![user.into()])).await?.ok_or_else(ApiError::unavailable)?;
    Ok(row.try_get("", "pending")?)
}
/// Explicit self-close uses the same bounded pruning as expiry; no separate closed-row inventory.
pub(crate) async fn close(
    tx: &DatabaseTransaction,
    context: &crate::rpc::RequestContext,
    id: &str,
) -> DomainResult<()> {
    let Some(row) = tx
        .query_one_raw(sql(
            "SELECT initiator_id,grant_digests FROM hyori_editor_sessions WHERE id=$1 FOR UPDATE",
            vec![id.into()],
        ))
        .await?
    else {
        return Ok(());
    };
    let initiator: Option<String> = row.try_get("", "initiator_id")?;
    let own = if let Some(initiator) = initiator {
        let actor = crate::features::files::policy::resolve_actor(tx, context).await?;
        actor.user_id() == Some(initiator.as_str())
    } else {
        let original: Vec<String> = serde_json::from_value(row.try_get("", "grant_digests")?)
            .map_err(|_| ApiError::unavailable())?;
        let held: Vec<_> = context
            .grants
            .iter()
            .filter(|token| original.contains(&crate::auth::digest(token)))
            .collect();
        // Revocation/expiry does not grant file access, but a retained issued credential can release
        // its own handle. Requiring issuance excludes arbitrary noise cookies captured by old opens:
        // a capability's MAC must verify (its expiry ignored), or a stored grant must exist.
        let digests: Vec<_> = held
            .iter()
            .map(|token| crate::auth::digest(token))
            .collect();
        issued_capability(tx, context, &held).await?
            || (!digests.is_empty() && tx.query_one_raw(sql("SELECT token_digest FROM hyori_grants WHERE token_digest IN (SELECT jsonb_array_elements_text($1::jsonb)) LIMIT 1",vec![serde_json::json!(digests).into()])).await?.is_some())
    };
    if !own {
        return Ok(());
    }
    remove(tx, &[id.to_owned()]).await
}
/// Whether one of `tokens` is a capability this server issued for its link with the link's
/// current password, whatever its expiry or the link's revocation.
async fn issued_capability(
    tx: &DatabaseTransaction,
    context: &crate::rpc::RequestContext,
    tokens: &[&String],
) -> DomainResult<bool> {
    let Some(key) = &context.capability_key else {
        return Ok(false);
    };
    for capability in tokens.iter().filter_map(|token| Capability::parse(token)) {
        let Some(row) = tx
            .query_one_raw(sql(
                "SELECT password_hash FROM hyori_shares WHERE id=$1",
                vec![capability.share_id.into()],
            ))
            .await?
        else {
            continue;
        };
        let hash: Option<String> = row.try_get("", "password_hash")?;
        if capability.verifies(key, hash.as_deref()) {
            return Ok(true);
        }
    }
    Ok(false)
}
async fn remove(tx: &DatabaseTransaction, ids: &[String]) -> DomainResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let saves = tx.query_all_raw(sql("SELECT upload_id FROM hyori_editor_saves WHERE session_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY upload_id LIMIT 256",vec![serde_json::json!(ids).into()])).await?;
    for save in saves {
        let id: String = save.try_get("", "upload_id")?;
        let upload = Upload::get(tx, &id).await?;
        if upload.state != "complete" {
            upload.abort(tx).await?;
        }
        tx.execute_raw(sql(
            "DELETE FROM hyori_editor_saves WHERE upload_id=$1",
            vec![id.into()],
        ))
        .await?;
    }
    tx.execute_raw(sql("DELETE FROM hyori_editor_sessions s WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND NOT EXISTS (SELECT 1 FROM hyori_editor_saves v WHERE v.session_id=s.id)",vec![serde_json::json!(ids).into()])).await?;
    Ok(())
}

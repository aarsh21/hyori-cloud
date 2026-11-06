//! Bounded editor retention. Exact-key upload inventory outlives sensitive session/save metadata.
use crate::{
    db::{self, DomainResult, sql},
    error::ApiError,
    features::uploads::db::Upload,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseTransaction};

pub async fn run_once(connection: &DatabaseConnection) -> Result<(), ApiError> {
    db::domain(connection, |tx| Box::pin(async move {
        let sessions = tx.query_all_raw(sql("SELECT id FROM hyori_editor_sessions WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 256 FOR UPDATE SKIP LOCKED",vec![])).await?;
        let ids: Vec<String> = sessions.into_iter().map(|row| row.try_get("","id")).collect::<Result<_,_>>()?;
        remove(tx,&ids).await
    })).await
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
        let matching: Vec<_> = context
            .grants
            .iter()
            .map(|token| crate::auth::digest(token))
            .filter(|digest| original.contains(digest))
            .collect();
        // Revocation/expiry does not grant file access, but a retained issued credential can release
        // its own handle. Requiring issuance excludes arbitrary noise cookies captured by old opens.
        !matching.is_empty() && tx.query_one_raw(sql("SELECT token_digest FROM hyori_grants WHERE token_digest IN (SELECT jsonb_array_elements_text($1::jsonb)) LIMIT 1",vec![serde_json::json!(matching).into()])).await?.is_some()
    };
    if !own {
        return Ok(());
    }
    remove(tx, &[id.to_owned()]).await
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

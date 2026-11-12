//! Upload fairness: authenticated account identity survives session changes, while every
//! qualifying public link also has a shared budget across independently issued visitor grants.
use crate::{
    AppState,
    auth::digest,
    db::{self, sql},
    error::ApiError,
    features::{
        files::policy as files,
        uploads::{api::BeginUpload, http::PrincipalSlot, policy},
    },
    rpc::RequestContext,
};
use sea_orm::ConnectionTrait;
use std::{sync::Arc, time::Duration};

// The SDK runs two files concurrently and sends each file's parts serially. A public link
// admits two such queues, but cannot exhaust all sixteen process-wide operations.
const PER_PRINCIPAL: usize = 2;
const PER_LINK: usize = 4;

pub(crate) struct Admission {
    _principals: Vec<PrincipalSlot>,
    _global: tokio::sync::OwnedSemaphorePermit,
}

pub(crate) async fn begin(
    state: &Arc<AppState>,
    context: &RequestContext,
    input: &BeginUpload,
) -> Result<Admission, ApiError> {
    // Bound even untrusted authorization lookups. A principal refusal drops this immediately;
    // no request waits for a principal while holding a global slot.
    let global = state
        .uploads
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::upload_busy())?;
    let keys = db::domain(&state.db, |tx| {
        let (context, input) = (context.clone(), input.clone());
        Box::pin(async move {
            let actor = files::resolve_actor(tx, &context).await?;
            keys(
                tx,
                &context,
                &actor,
                input.parent_id.0.as_ref().map(|id| id.0.as_str()),
                input.replace_id.as_ref().map(|id| id.0.as_str()),
            )
            .await
        })
    })
    .await?;
    acquire(state, keys, global).await
}

pub(crate) async fn existing(
    state: &Arc<AppState>,
    context: &RequestContext,
    id: &str,
) -> Result<Admission, ApiError> {
    let global = state
        .uploads
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::upload_busy())?;
    let keys = db::domain(&state.db, |tx| {
        let (context, id) = (context.clone(), id.to_owned());
        Box::pin(async move {
            let (upload, actor) = policy::initiated(tx, &context, &id).await?;
            if matches!(upload.state.as_str(), "complete" | "aborted") {
                // Terminal replay still gets admission, but must not require the old folder.
                return Ok(vec![(principal(&context, &actor), PER_PRINCIPAL)]);
            }
            keys(
                tx,
                &context,
                &actor,
                upload.parent_id.as_deref(),
                upload.replace_id.as_deref(),
            )
            .await
        })
    })
    .await?;
    acquire(state, keys, global).await
}

fn principal(context: &RequestContext, actor: &files::ProductActor) -> String {
    if let Some(user) = actor.user_id() {
        format!("user:{user}")
    } else {
        let mut grants: Vec<_> = context.grants.iter().map(|token| digest(token)).collect();
        grants.sort_unstable();
        format!("visitor:{}", digest(&grants.join(".")))
    }
}

async fn keys(
    tx: &sea_orm::DatabaseTransaction,
    context: &RequestContext,
    actor: &files::ProductActor,
    parent: Option<&str>,
    replacement: Option<&str>,
) -> db::DomainResult<Vec<(String, usize)>> {
    let (destination, previous) = policy::destination(tx, actor, parent, replacement).await?;
    let mut keys = vec![(principal(context, actor), PER_PRINCIPAL)];
    if actor.user_id() != Some(destination.owner_id.as_str()) && !actor.public_shares().is_empty() {
        let roots = if let Some(previous) = previous {
            let mut roots = previous.ancestor_ids;
            roots.push(previous.id);
            roots
        } else {
            destination.ancestor_ids
        };
        // Charge every applicable link, not a caller-selected one or a grant-set hash. Changing
        // sessions, acquiring new grants or adding an unrelated grant cannot evade this budget.
        let links = tx.query_all_raw(sql(
            "SELECT id FROM hyori_shares WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND item_id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND (role='editor' OR (role='contributor' AND NOT $3)) LIMIT 16",
            vec![serde_json::json!(actor.public_shares()).into(),serde_json::json!(roots).into(),replacement.is_some().into()],
        )).await?;
        for link in links {
            keys.push((
                format!("link:{}", link.try_get::<String>("", "id")?),
                PER_LINK,
            ));
        }
    }
    Ok(keys)
}

async fn acquire(
    state: &Arc<AppState>,
    keys: Vec<(String, usize)>,
    global: tokio::sync::OwnedSemaphorePermit,
) -> Result<Admission, ApiError> {
    let mut principals = Vec::with_capacity(keys.len());
    for (key, limit) in keys {
        principals.push(
            state
                .upload_principals
                .acquire(key, limit, 0, Duration::ZERO)
                .await
                .ok_or_else(ApiError::upload_busy)?,
        );
    }
    Ok(Admission {
        _principals: principals,
        _global: global,
    })
}

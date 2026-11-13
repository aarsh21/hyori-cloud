use crate::{
    auth::digest,
    db::{DomainResult, sql},
    error::{ApiError, ErrorCode},
    features::{
        files::{
            api::FileKind,
            db::Item,
            policy::{self, Action, Destination, ProductActor},
        },
        uploads::db::Upload,
    },
    rpc::RequestContext,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};

pub(crate) async fn destination(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    parent: Option<&str>,
    replacement: Option<&str>,
) -> DomainResult<(Destination, Option<Item>)> {
    if let Some(id) = replacement {
        let item = policy::authorize(tx, actor, id, Action::Edit, false).await?;
        if item.kind != FileKind::File
            || item.mime_type == crate::features::notes::service::MIME
            || item.parent_id.as_deref() != parent
        {
            return Err(ApiError::conflict().into());
        }
        // A directly shared file may be edited without access to its containing folder.
        let parent = if let Some(id) = parent {
            Some(Item::get(tx, id).await?)
        } else {
            None
        };
        if parent
            .as_ref()
            .is_some_and(|p| p.trashed_at.is_some() || p.owner_id != item.owner_id)
        {
            return Err(ApiError::conflict().into());
        }
        Ok((
            Destination {
                owner_id: item.owner_id.clone(),
                ancestor_ids: item.ancestor_ids.clone(),
                parent,
            },
            Some(item),
        ))
    } else {
        Ok((policy::destination(tx, actor, parent).await?, None))
    }
}

pub(crate) async fn initiated(
    tx: &DatabaseTransaction,
    context: &RequestContext,
    id: &str,
) -> DomainResult<(Upload, ProductActor)> {
    let upload = Upload::get(tx, id).await?;
    let mut context = context.clone();
    if upload.uploader_id.is_none() {
        context.session = None;
        context
            .grants
            .retain(|token| upload.grant_digests.contains(&digest(token)));
    }
    let actor = policy::resolve_actor(tx, &context).await?;
    if upload.uploader_id.as_deref() != actor.user_id()
        || (upload.uploader_id.is_none() && actor.public_shares().is_empty())
    {
        return Err(ApiError::denied().into());
    }
    Ok((upload, actor))
}

pub(crate) async fn checked(
    tx: &DatabaseTransaction,
    assets: &crate::editor_assets::EditorAssets,
    context: &RequestContext,
    id: &str,
) -> DomainResult<(Upload, ProductActor)> {
    let (mut upload, actor) = initiated(tx, context, id).await?;
    crate::features::editors::policy::check_upload(tx, assets, context, &upload).await?;
    if upload.state == "complete" {
        let current = policy::authorize(
            tx,
            &actor,
            upload
                .file_id
                .as_deref()
                .ok_or_else(ApiError::unavailable)?,
            Action::Read,
            false,
        )
        .await?;
        // Replay preserves the terminal outcome but never stale capability flags.
        if let Some(result) = upload.result.as_mut() {
            result["access"] = serde_json::to_value(policy::access(&current, &actor))
                .map_err(|_| ApiError::unavailable())?;
        }
    } else if upload.state != "aborted" {
        let (destination, replacement) = destination(
            tx,
            &actor,
            upload.parent_id.as_deref(),
            upload.replace_id.as_deref(),
        )
        .await?;
        if destination.owner_id != upload.owner_id
            || replacement
                .as_ref()
                .is_some_and(|p| Some(p.revision) != upload.replace_revision)
        {
            return Err(ApiError::conflict().into());
        }
    }
    Ok((upload, actor))
}

pub(crate) async fn quota(
    tx: &DatabaseTransaction,
    owner: &str,
    additional: i64,
) -> DomainResult<()> {
    let row = tx.query_one_raw(sql("SELECT used_bytes,reserved_bytes,quota_bytes FROM hyori_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE", vec![owner.into()])).await?.ok_or_else(ApiError::denied)?;
    if row.try_get::<i64>("", "used_bytes")?
        + row.try_get::<i64>("", "reserved_bytes")?
        + additional
        > row.try_get::<i64>("", "quota_bytes")?
    {
        return Err(ApiError::new(ErrorCode::QuotaExceeded, "Not enough storage quota").into());
    }
    Ok(())
}

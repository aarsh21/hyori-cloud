use crate::{
    auth::digest,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        editors::{api::*, formats},
        files::{
            db::Item,
            policy::{self as files, Action, ProductActor},
        },
        uploads::db::Upload,
    },
    rpc::RequestContext,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};

pub(crate) struct Session {
    pub id: String,
    pub file_id: String,
    pub initiator_id: Option<String>,
    pub grants: Vec<String>,
    pub app: EditorApp,
    pub version: String,
    pub revision: i64,
    pub name: String,
}
impl Session {
    fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            file_id: row.try_get("", "file_id")?,
            initiator_id: row.try_get("", "initiator_id")?,
            grants: serde_json::from_value(row.try_get("", "grant_digests")?)
                .map_err(|_| ApiError::unavailable())?,
            app: serde_json::from_value(serde_json::Value::String(row.try_get("", "app")?))
                .map_err(|_| ApiError::unavailable())?,
            version: row.try_get("", "version")?,
            revision: row.try_get("", "revision")?,
            name: row.try_get("", "name")?,
        })
    }
}
pub(crate) async fn enabled(
    tx: &DatabaseTransaction,
    assets: &crate::editor_assets::EditorAssets,
    app: &EditorApp,
) -> DomainResult<()> {
    let capability = assets.capability(app)?;
    if tx
        .query_one_raw(sql(
            "SELECT app FROM hyori_editor_assets WHERE app=$1 AND version=$2 AND enabled",
            vec![
                formats::app_name(app).into(),
                capability.version.clone().into(),
            ],
        ))
        .await?
        .is_none()
    {
        return Err(ApiError::unavailable().into());
    }
    Ok(())
}
pub(crate) async fn session(
    tx: &DatabaseTransaction,
    assets: &crate::editor_assets::EditorAssets,
    context: &RequestContext,
    id: &str,
    action: Action,
) -> DomainResult<(Session, ProductActor, Item)> {
    let session = Session::from_row(
        tx.query_one_raw(sql(
            "SELECT id,file_id,initiator_id,grant_digests,app,version,revision,name FROM hyori_editor_sessions WHERE id=$1 AND expires_at>now()",
            vec![id.into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?,
    )?;
    let mut context = context.clone();
    if session.initiator_id.is_none() {
        context.session = None;
        context
            .grants
            .retain(|token| session.grants.contains(&digest(token)));
    }
    let actor = files::resolve_actor(tx, &context).await?;
    if actor.user_id() != session.initiator_id.as_deref()
        || (session.initiator_id.is_none() && actor.public_shares().is_empty())
    {
        return Err(ApiError::denied().into());
    }
    assets.version_capability(&session.app, &session.version)?;
    // The app kill-switch applies to both versions; selected-current changes never revoke a
    // still-verified legacy tab's ability to reconcile its own revision-fenced save.
    if tx
        .query_one_raw(sql(
            "SELECT app FROM hyori_editor_assets WHERE app=$1 AND enabled",
            vec![formats::app_name(&session.app).into()],
        ))
        .await?
        .is_none()
    {
        return Err(ApiError::unavailable().into());
    }
    let item = files::authorize(tx, &actor, &session.file_id, action, false).await?;
    Ok((session, actor, item))
}
pub(crate) fn revision(session: &Session, item: &Item, expected: i64) -> DomainResult<()> {
    if session.revision != expected || item.revision != expected || item.name != session.name {
        return Err(ApiError::conflict().into());
    }
    Ok(())
}
/// Invoked by every generic upload authorization path, including terminal replay.
pub(crate) async fn check_upload(
    tx: &DatabaseTransaction,
    assets: &crate::editor_assets::EditorAssets,
    context: &RequestContext,
    upload: &Upload,
) -> DomainResult<()> {
    if !upload.editor_bound {
        return Ok(());
    }
    let save = tx
        .query_one_raw(sql(
            "SELECT session_id,expected_revision,intent FROM hyori_editor_saves WHERE upload_id=$1",
            vec![upload.id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?;
    let action = match save.try_get::<String>("", "intent")?.as_str() {
        "replace" => Action::Edit,
        "save-as" | "export" => Action::Read,
        _ => return Err(ApiError::unavailable().into()),
    };
    let (session, _, item) = session(
        tx,
        assets,
        context,
        &save.try_get::<String>("", "session_id")?,
        action,
    )
    .await?;
    if upload.state != "complete" {
        revision(&session, &item, save.try_get("", "expected_revision")?)?;
    }
    Ok(())
}
/// The caller publishes this result in the very same transaction as file/history/quota metadata.
pub(crate) async fn published(
    tx: &DatabaseTransaction,
    upload: &Upload,
    item: &Item,
    file: &crate::features::files::api::FileEntry,
) -> DomainResult<()> {
    if !upload.editor_bound {
        return Ok(());
    }
    let save = tx
        .query_one_raw(sql(
            "SELECT session_id,intent,expected_revision,save_mode FROM hyori_editor_saves WHERE upload_id=$1",
            vec![upload.id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?;
    let replacement = save.try_get::<String>("", "intent")? == "replace";
    let revision = if replacement {
        item.revision
    } else {
        save.try_get("", "expected_revision")?
    };
    let result = EditorSaved {
        status: EditorSavedStatus::Saved,
        revision: revision.to_string(),
        file: file.clone(),
    };
    let session: String = save.try_get("", "session_id")?;
    let automatic = save.try_get::<String>("", "save_mode")? == "automatic";
    let sequence = tx.query_one_raw(sql(
        "UPDATE hyori_editor_sessions SET outcome_sequence=outcome_sequence+1,revision=CASE WHEN $2 THEN $3 ELSE revision END,last_auto_upload_id=CASE WHEN NOT $2 THEN last_auto_upload_id WHEN $4 THEN $5 ELSE NULL END,last_auto_revision=CASE WHEN NOT $2 THEN last_auto_revision WHEN $4 THEN $3 ELSE NULL END,checkpoint_at=CASE WHEN $2 AND NOT $4 THEN NULL ELSE checkpoint_at END WHERE id=$1 RETURNING outcome_sequence",
        vec![session.clone().into(),replacement.into(),revision.into(),automatic.into(),upload.id.clone().into()],
    )).await?.ok_or_else(ApiError::not_found)?.try_get::<i64>("", "outcome_sequence")?;
    tx.execute_raw(sql(
        "UPDATE hyori_editor_saves SET result=$2,outcome_sequence=$3 WHERE upload_id=$1 AND result IS NULL",
        vec![
            upload.id.clone().into(),
            serde_json::to_value(result)
                .map_err(|_| ApiError::unavailable())?
                .into(),
            sequence.into(),
        ],
    ))
    .await?;
    super::retention::prune(tx, &session).await
}

use crate::{
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Id, Name},
        files::{
            api::FileKind,
            db::Item,
            policy::{self, ProductActor},
        },
        photos::api::{Album, PhotoSources},
    },
};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};

pub(crate) async fn sources(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
) -> DomainResult<PhotoSources> {
    let saved = tx
        .query_one_raw(sql(
            "SELECT all_my_files,folder_ids FROM hyori_photo_sources WHERE user_id=$1",
            vec![actor.require_user()?.into()],
        ))
        .await?;
    let Some(saved) = saved else {
        return Ok(PhotoSources {
            all_my_files: false,
            folder_ids: vec![],
        });
    };
    let ids: Vec<Id> = serde_json::from_value(saved.try_get("", "folder_ids")?)
        .map_err(|_| ApiError::unavailable())?;
    Ok(PhotoSources {
        all_my_files: saved.try_get("", "all_my_files")?,
        folder_ids: available_folders(tx, actor, &ids).await?,
    })
}

/// Bounded candidate lookup and one role aggregation, never a global grant enumeration.
pub(crate) async fn available_items(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    ids: &[Id],
) -> DomainResult<Vec<Item>> {
    let mut items = tx.query_all_raw(sql(
        "SELECT i.* FROM hyori_items i JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
         WHERE i.id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND i.trashed_at IS NULL LIMIT 100",
        vec![serde_json::json!(ids).into()],
    )).await?.into_iter().map(Item::from_row).collect::<DomainResult<Vec<_>>>()?;
    policy::load_roles(tx, actor, &mut items).await?;
    items.retain(|item| policy::access(item, actor).can_download);
    Ok(items)
}
pub(crate) async fn available_folders(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    ids: &[Id],
) -> DomainResult<Vec<Id>> {
    let available = available_items(tx, actor, ids).await?;
    let mut selected = std::collections::HashSet::new();
    Ok(ids
        .iter()
        .filter(|id| {
            available
                .iter()
                .any(|item| item.id == id.0 && item.kind == FileKind::Folder)
                && selected.insert(id.0.clone())
        })
        .cloned()
        .collect())
}
pub(crate) async fn require_album(
    tx: &DatabaseTransaction,
    user: &str,
    id: &str,
) -> DomainResult<()> {
    if tx
        .query_one_raw(sql(
            "SELECT id FROM hyori_photo_albums WHERE id=$1 AND owner_id=$2",
            vec![id.into(), user.into()],
        ))
        .await?
        .is_none()
    {
        return Err(ApiError::not_found().into());
    }
    Ok(())
}
pub(crate) fn album(row: QueryResult) -> DomainResult<Album> {
    Ok(Album {
        id: Id(row.try_get("", "id")?),
        name: Name(row.try_get("", "name")?),
        created_at: row.try_get::<DateTime<Utc>>("", "created_at")?.to_rfc3339(),
        count: row.try_get::<i64>("", "count")? as f64,
    })
}

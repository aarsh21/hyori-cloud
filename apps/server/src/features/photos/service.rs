use crate::{
    AppState,
    auth::random_token,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Done, Id, Name},
        files::{db::Item, policy, preview::preview_url, service::FilesService},
        photos::{api::*, db},
    },
    rpc::RequestContext,
    wire::Nullable,
};
use chrono::{DateTime, Utc};
use sea_orm::ConnectionTrait;
use std::sync::Arc;

use crate::features::files::preview::MEDIA;

pub(crate) struct PhotosService {
    files: FilesService,
    media_enabled: bool,
}
impl PhotosService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            files: FilesService::new(state, context),
            media_enabled: state.media_worker.is_some(),
        }
    }
    pub async fn sources(&self) -> Result<PhotoSources, ApiError> {
        self.files
            .run(|tx, actor| Box::pin(async move { db::sources(tx, &actor).await }))
            .await
    }
    pub async fn set_sources(&self, input: PhotoSources) -> Result<PhotoSources, ApiError> {
        if input.folder_ids.len() > 100 {
            return Err(ApiError::invalid());
        }
        self.files.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let user = actor.require_user()?;
                // Reconcile disappeared/revoked sources without revealing which private IDs exist.
                let folder_ids = db::available_folders(tx, &actor, &input.folder_ids).await?;
                tx.execute_raw(sql("INSERT INTO hyori_photo_sources(user_id,all_my_files,folder_ids) VALUES ($1,$2,$3)
                    ON CONFLICT(user_id) DO UPDATE SET all_my_files=excluded.all_my_files,folder_ids=excluded.folder_ids",
                    vec![user.into(),input.all_my_files.into(),serde_json::json!(folder_ids).into()])).await?;
                Ok(PhotoSources { all_my_files: input.all_my_files, folder_ids })
            })
        }).await
    }
    pub async fn timeline(&self, input: TimelineInput) -> Result<Timeline, ApiError> {
        let cursor = timeline_cursor(input.cursor.as_ref().and_then(|value| value.0.as_deref()))?;
        let media_enabled = self.media_enabled;
        self.files.run(move |tx, actor| {
            let input = input.clone();
            let cursor = cursor.clone();
            Box::pin(async move {
                let user = actor.require_user()?;
                let album = input.album_id.map(|id| id.0);
                let sources = if let Some(id) = &album {
                    db::require_album(tx, user, id).await?;
                    PhotoSources { all_my_files: false, folder_ids: vec![] }
                } else { db::sources(tx, &actor).await? };
                let mut rows = tx.query_all_raw(sql(
                    "SELECT i.* FROM hyori_items i JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                     WHERE i.kind='file' AND i.trashed_at IS NULL
                       AND i.mime_type IN (SELECT jsonb_array_elements_text($3::jsonb))
                       AND (i.owner_id=$1 OR EXISTS (
                         SELECT 1 FROM jsonb_array_elements_text(i.ancestor_ids || jsonb_build_array(i.id)) AS root(id)
                         JOIN hyori_shares s ON s.item_id=root.id AND s.revoked_at IS NULL
                         JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
                         WHERE (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb))))
                           AND (s.expires_at IS NULL OR s.expires_at>now())))
                       AND CASE WHEN $4::text IS NOT NULL THEN EXISTS (
                         SELECT 1 FROM hyori_photo_album_items a WHERE a.album_id=$4 AND a.file_id=i.id)
                         ELSE (($5 AND i.owner_id=$1) OR i.ancestor_ids ?| ARRAY(SELECT jsonb_array_elements_text($6::jsonb))) END
                       AND ($7::timestamptz IS NULL OR (i.created_at,i.id)<($7,$8))
                     ORDER BY i.created_at DESC,i.id DESC LIMIT 101",
                    vec![user.into(),serde_json::json!(actor.public_shares()).into(),serde_json::json!(MEDIA).into(),album.into(),sources.all_my_files.into(),serde_json::json!(sources.folder_ids).into(),cursor.as_ref().map(|c| c.0).into(),cursor.as_ref().map(|c| c.1.clone()).into()],
                )).await?.into_iter().map(Item::from_row).collect::<DomainResult<Vec<_>>>()?;
                let next_cursor = if rows.len() > 100 { Some(format!("{}|{}",rows[99].created_at.to_rfc3339(),rows[99].id)) } else { None };
                rows.truncate(100);
                policy::load_roles(tx, &actor, &mut rows).await?;
                let derivatives=crate::features::media::service::describe_page(tx,&rows,media_enabled).await?;
                Ok(Timeline { items: rows.iter().zip(derivatives).map(|(item,derivative)| TimelineItem { file: policy::project(item,&actor), preview_url: preview_url(&item.id, None, item.revision), derivative: Some(derivative) }).collect(), next_cursor: Nullable(next_cursor), breadcrumbs: vec![], folder: Nullable(None) })
            })
        }).await
    }
    pub async fn albums(&self) -> Result<Albums, ApiError> {
        self.files.run(|tx, actor| Box::pin(async move {
            let rows = tx.query_all_raw(sql("SELECT a.*, (SELECT count(*) FROM hyori_photo_album_items i WHERE i.album_id=a.id) AS count
                FROM hyori_photo_albums a WHERE a.owner_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT 100", vec![actor.require_user()?.into()])).await?;
            Ok(Albums { items: rows.into_iter().map(db::album).collect::<DomainResult<Vec<_>>>()? })
        })).await
    }
    pub async fn create_album(&self, input: CreateAlbum) -> Result<Album, ApiError> {
        let name = policy::normalize_name(&input.name.0)?;
        self.files.run(move |tx, actor| {
            let name = name.clone();
            Box::pin(async move {
                let user = actor.require_user()?;
                let count = tx.query_one_raw(sql("SELECT count(*) AS count FROM hyori_photo_albums WHERE owner_id=$1", vec![user.into()])).await?.ok_or_else(ApiError::unavailable)?.try_get::<i64>("", "count")?;
                if count >= 100 { return Err(ApiError::conflict().into()); }
                let id = random_token();
                let now = Utc::now();
                tx.execute_raw(sql("INSERT INTO hyori_photo_albums(id,owner_id,name,created_at) VALUES ($1,$2,$3,$4)", vec![id.clone().into(),user.into(),name.clone().into(),now.into()])).await?;
                Ok(Album { id: Id(id), name: Name(name), created_at: now.to_rfc3339(), count: 0.0 })
            })
        }).await
    }
    pub async fn add_to_album(&self, input: AddToAlbum) -> Result<Done, ApiError> {
        if input.file_ids.len() > 100 {
            return Err(ApiError::invalid());
        }
        self.files.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                db::require_album(tx, actor.require_user()?, &input.album_id.0).await?;
                let items = db::available_items(tx, &actor, &input.file_ids).await?;
                if input.file_ids.iter().any(|id| !items.iter().any(|item| item.id == id.0 && MEDIA.contains(&item.mime_type.as_str()) && item.kind == crate::features::files::api::FileKind::File)) {
                    return Err(ApiError::not_found().into());
                }
                tx.execute_raw(sql("INSERT INTO hyori_photo_album_items(album_id,file_id) SELECT $1,id FROM jsonb_array_elements_text($2::jsonb) AS ids(id) ON CONFLICT DO NOTHING", vec![input.album_id.0.clone().into(),serde_json::json!(input.file_ids).into()])).await?;
                let count = tx.query_one_raw(sql("SELECT count(*) AS count FROM hyori_photo_album_items WHERE album_id=$1", vec![input.album_id.0.into()])).await?.ok_or_else(ApiError::unavailable)?.try_get::<i64>("", "count")?;
                if count > 1000 { return Err(ApiError::conflict().into()); }
                Ok(Done { success: true })
            })
        }).await
    }
}
fn timeline_cursor(cursor: Option<&str>) -> Result<Option<(DateTime<Utc>, String)>, ApiError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.len() > 200 {
        return Err(ApiError::invalid());
    }
    let (date, id) = cursor.split_once('|').ok_or_else(ApiError::invalid)?;
    let date = DateTime::parse_from_rfc3339(date)
        .map_err(|_| ApiError::invalid())?
        .with_timezone(&Utc);
    let id = policy::cursor(Some(id))?;
    if id.is_empty() {
        return Err(ApiError::invalid());
    }
    Ok(Some((date, id.to_owned())))
}

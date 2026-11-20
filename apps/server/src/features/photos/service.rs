use crate::{
    AppState,
    auth::random_token,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Done, Id, Name},
        files::{db::Item, policy, preview::preview_url, service::FilesService},
        media::{
            api::{DisplayPreview, MediaDerivative},
            service::{describe_display_page, describe_page},
        },
        photos::{api::*, db},
    },
    media_worker::WorkerClient,
    rpc::RequestContext,
    wire::Nullable,
};
use chrono::{DateTime, NaiveDateTime, Utc};
use sea_orm::{ConnectionTrait, Statement};
use std::sync::Arc;

use crate::features::files::preview::MEDIA;

// Timeline scopes are driven from the album, the actor's own media index, or the chosen source
// folders' subtrees, never from the instance-wide media timeline. Shared bindings: $1 actor,
// $2 public grants, $3 media types, $4/$5 cursor. Items reached through a source folder or album
// are visible when owned or under one of the actor's eligible share roots, the same rule as
// `policy::load_roles`, checked against the materialized roots rather than a per-row subplan.
const ACTIVE_OWNER: &str = "JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'";
const TIMELINE_PAGE: &str = "i.kind='file' AND i.trashed_at IS NULL
    AND i.mime_type=ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))
    AND ($4::timestamptz IS NULL OR (i.created_at,i.id)<($4,$5))";
const VISIBLE: &str = "(i.owner_id=$1 OR i.id=ANY(ARRAY(SELECT item_id FROM eligible))
    OR i.ancestor_ids ?| ARRAY(SELECT item_id FROM eligible))";
const TIMELINE_ORDER: &str = "ORDER BY i.created_at DESC,i.id DESC LIMIT 101";
// Literal predicates allow PostgreSQL to prove the partial index applies to prepared statements.
const LIBRARY_MEDIA: &str = "kind='file' AND trashed_at IS NULL AND object_key IS NOT NULL AND mime_type IN
    ('image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif','video/mp4','video/webm','video/quicktime')";
const LIBRARY_TIME: &str = "coalesce(photo_taken_at, created_at AT TIME ZONE 'UTC')";

pub(crate) struct PhotosService {
    files: FilesService,
    worker: Option<WorkerClient>,
}
impl PhotosService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            files: FilesService::new(state, context),
            worker: state.media_worker.clone(),
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
    pub async fn library(&self, input: LibraryInput) -> Result<PhotoLibrary, ApiError> {
        let cursor = library_cursor(input.cursor.as_ref().and_then(|value| value.0.as_deref()))?;
        let media_enabled = self.worker.is_some();
        let mut page = self.files.run(move |tx, actor| {
            let cursor = cursor.clone();
            Box::pin(async move {
                let mut values = vec![actor.require_user()?.into()];
                let seek = if let Some((date_time, id)) = cursor {
                    values.extend([date_time.into(), id.into()]);
                    format!(" AND ({LIBRARY_TIME},id)<($2,$3)")
                } else {
                    String::new()
                };
                let mut rows = tx.query_all_raw(sql(&format!(
                    "SELECT id,owner_id,parent_id,name,kind,size,mime_type,object_key,uploaded_by,ancestor_ids,
                            revision,trash_root,trashed_at,created_at,updated_at,
                            photo_taken_at IS NOT NULL AS captured,{LIBRARY_TIME} AS timeline_time
                     FROM hyori_items WHERE owner_id=$1 AND {LIBRARY_MEDIA}{seek}
                     ORDER BY timeline_time DESC,id DESC LIMIT 101"), values)).await?;
                let next_cursor = if rows.len() > 100 {
                    let boundary = &rows[99];
                    let time: NaiveDateTime = boundary.try_get("", "timeline_time")?;
                    let id: String = boundary.try_get("", "id")?;
                    Some(format!("library1|{}|{id}", time.format("%Y-%m-%dT%H:%M:%S%.f")))
                } else {
                    None
                };
                rows.truncate(100);
                let mut dates = Vec::with_capacity(rows.len());
                let mut items = Vec::with_capacity(rows.len());
                for row in rows {
                    let time: NaiveDateTime = row.try_get("", "timeline_time")?;
                    let captured: bool = row.try_get("", "captured")?;
                    dates.push((time.date(), captured));
                    items.push(Item::from_row(row)?);
                }
                // Ownership is the scope; incoming share-role resolution is neither needed nor used.
                let derivatives = describe_page(tx, &items, media_enabled).await?;
                let displays = describe_display_page(tx, &items, media_enabled).await?;
                Ok(PhotoLibrary {
                    items: items.iter().zip(derivatives).zip(displays).zip(dates).map(|(((item, derivative), display), (date, captured))| LibraryItem {
                        item: timeline_item(item, &actor, derivative, display),
                        timeline_date: date.to_string(),
                        date_source: if captured { PhotoDateSource::Capture } else { PhotoDateSource::Upload },
                    }).collect(),
                    next_cursor: Nullable(next_cursor),
                    preview_worker: None,
                })
            })
        }).await?;
        page.preview_worker = Some(match &self.worker {
            Some(worker) if worker.available().await => PreviewWorker::Available,
            _ => PreviewWorker::Unavailable,
        });
        Ok(page)
    }
    pub async fn details(&self, id: Id) -> Result<PhotoDetails, ApiError> {
        self.files
            .run(move |tx, actor| {
                let id = id.0.clone();
                Box::pin(async move {
                    let row = tx
                        .query_one_raw(sql(
                            &format!(
                    "SELECT photo_taken_at,photo_offset_minutes,photo_latitude,photo_longitude,
                            photo_camera_make,photo_camera_model,photo_width,photo_height
                     FROM hyori_items WHERE owner_id=$1 AND id=$2 AND {LIBRARY_MEDIA}"),
                            vec![actor.require_user()?.into(), id.into()],
                        ))
                        .await?
                        .ok_or_else(ApiError::not_found)?;
                    let time: Option<NaiveDateTime> = row.try_get("", "photo_taken_at")?;
                    let offset = row.try_get("", "photo_offset_minutes")?;
                    let latitude: Option<f64> = row.try_get("", "photo_latitude")?;
                    let longitude: Option<f64> = row.try_get("", "photo_longitude")?;
                    let make: Option<String> = row.try_get("", "photo_camera_make")?;
                    let model: Option<String> = row.try_get("", "photo_camera_model")?;
                    let width: Option<i32> = row.try_get("", "photo_width")?;
                    let height: Option<i32> = row.try_get("", "photo_height")?;
                    Ok(PhotoDetails {
                        capture: Nullable(time.map(|time| PhotoCapture {
                            local_date_time: time.format("%Y-%m-%dT%H:%M:%S%.f").to_string(),
                            offset_minutes: Nullable(offset),
                        })),
                        location: Nullable(latitude.zip(longitude).map(|(latitude, longitude)| {
                            PhotoLocation {
                                latitude,
                                longitude,
                            }
                        })),
                        camera: Some(Nullable((make.is_some() || model.is_some()).then_some(
                            PhotoCamera {
                                make: Nullable(make),
                                model: Nullable(model),
                            },
                        ))),
                        original_dimensions: Some(Nullable(width.zip(height).map(
                            |(width, height)| OriginalDimensions {
                                width: width as u32,
                                height: height as u32,
                            },
                        ))),
                    })
                })
            })
            .await
    }
    pub async fn timeline(&self, input: TimelineInput) -> Result<Timeline, ApiError> {
        let cursor = timeline_cursor(input.cursor.as_ref().and_then(|value| value.0.as_deref()))?;
        let media_enabled = self.worker.is_some();
        self.files
            .run(move |tx, actor| {
                let input = input.clone();
                let cursor = cursor.clone();
                Box::pin(async move {
                    let user = actor.require_user()?;
                    let album = input.album_id.map(|id| id.0);
                    let sources;
                    let scope = if let Some(id) = &album {
                        db::require_album(tx, user, id).await?;
                        TimelineScope::Album(id)
                    } else {
                        sources = db::sources(tx, &actor).await?;
                        TimelineScope::Sources(&sources)
                    };
                    let statement =
                        timeline_statement(user, actor.public_shares(), scope, cursor.as_ref());
                    let mut rows = tx
                        .query_all_raw(statement)
                        .await?
                        .into_iter()
                        .map(Item::from_row)
                        .collect::<DomainResult<Vec<_>>>()?;
                    let next_cursor = if rows.len() > 100 {
                        Some(format!(
                            "{}|{}",
                            rows[99].created_at.to_rfc3339(),
                            rows[99].id
                        ))
                    } else {
                        None
                    };
                    rows.truncate(100);
                    policy::load_roles(tx, &actor, &mut rows).await?;
                    let derivatives = describe_page(tx, &rows, media_enabled).await?;
                    let displays = describe_display_page(tx, &rows, media_enabled).await?;
                    Ok(Timeline {
                        items: rows
                            .iter()
                            .zip(derivatives)
                            .zip(displays)
                            .map(|((item, derivative), display)| {
                                timeline_item(item, &actor, derivative, display)
                            })
                            .collect(),
                        next_cursor: Nullable(next_cursor),
                        breadcrumbs: vec![],
                        folder: Nullable(None),
                    })
                })
            })
            .await
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
fn timeline_item(
    item: &Item,
    actor: &policy::ProductActor,
    derivative: MediaDerivative,
    display_preview: Option<DisplayPreview>,
) -> TimelineItem {
    TimelineItem {
        file: policy::project(item, actor),
        preview_url: preview_url(&item.id, None, item.revision),
        derivative: Some(derivative),
        display_preview,
    }
}
enum TimelineScope<'a> {
    Album(&'a str),
    Sources(&'a PhotoSources),
}
fn timeline_statement(
    user: &str,
    public_shares: &[String],
    scope: TimelineScope,
    cursor: Option<&(DateTime<Utc>, String)>,
) -> Statement {
    let mut values = vec![
        user.into(),
        serde_json::json!(public_shares).into(),
        serde_json::json!(MEDIA).into(),
        cursor.map(|c| c.0).into(),
        cursor.map(|c| c.1.clone()).into(),
    ];
    let eligible = policy::eligible_share_roots("$1", "$2");
    let statement = match scope {
        TimelineScope::Album(id) => {
            values.push(id.into());
            format!("WITH eligible AS MATERIALIZED ({eligible})
                SELECT i.* FROM hyori_photo_album_items a JOIN hyori_items i ON i.id=a.file_id {ACTIVE_OWNER}
                WHERE a.album_id=$6 AND {TIMELINE_PAGE} AND {VISIBLE} {TIMELINE_ORDER}")
        }
        TimelineScope::Sources(sources) => {
            values.extend([
                sources.all_my_files.into(),
                serde_json::json!(sources.folder_ids).into(),
            ]);
            format!(
                "WITH eligible AS MATERIALIZED ({eligible}), page AS MATERIALIZED (
                (SELECT i.id FROM hyori_items i {ACTIVE_OWNER}
                 WHERE $6 AND i.owner_id=$1 AND {TIMELINE_PAGE} {TIMELINE_ORDER})
                UNION
                (SELECT i.id FROM hyori_items i {ACTIVE_OWNER}
                 WHERE i.ancestor_ids ?| ARRAY(SELECT jsonb_array_elements_text($7::jsonb))
                   AND {TIMELINE_PAGE} AND {VISIBLE} {TIMELINE_ORDER})
            ) SELECT i.* FROM page p JOIN hyori_items i ON i.id=p.id {TIMELINE_ORDER}"
            )
        }
    };
    sql(&statement, values)
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

fn library_cursor(cursor: Option<&str>) -> Result<Option<(NaiveDateTime, String)>, ApiError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    if cursor.len() > 200 {
        return Err(ApiError::invalid());
    }
    let (time, id) = cursor
        .strip_prefix("library1|")
        .and_then(|value| value.split_once('|'))
        .ok_or_else(ApiError::invalid)?;
    let time = NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|_| ApiError::invalid())?;
    let id = policy::cursor(Some(id))?;
    if id.is_empty() {
        return Err(ApiError::invalid());
    }
    Ok(Some((time, id.to_owned())))
}

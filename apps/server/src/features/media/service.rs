use crate::{
    AppState,
    auth::random_token,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::Bytes,
        files::{
            api::{FileKind, ItemInput},
            db::Item,
            policy::{self, Action},
            service::FilesService,
        },
        media::api::*,
    },
    rpc::RequestContext,
};
use hyori_media_worker::{DISPLAY_RECIPE, Format, RECIPE};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};
use std::{collections::HashMap, sync::Arc};

pub(crate) struct MediaService {
    files: FilesService,
    enabled: bool,
}
impl MediaService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            files: FilesService::new(state, context),
            enabled: state.media_worker.is_some(),
        }
    }
    pub async fn get(&self, input: ItemInput) -> Result<MediaDerivative, ApiError> {
        let enabled = self.enabled;
        self.files
            .run(move |tx, actor| {
                let input = input.clone();
                Box::pin(async move {
                    let item =
                        policy::authorize(tx, &actor, &input.id.0, Action::Read, false).await?;
                    describe_page(tx, std::slice::from_ref(&item), enabled)
                        .await?
                        .pop()
                        .ok_or_else(|| ApiError::unavailable().into())
                })
            })
            .await
    }
    pub async fn retry(&self, input: ItemInput) -> Result<MediaDerivative, ApiError> {
        let enabled = self.enabled;
        self.files.run(move|tx,actor|{let input=input.clone();Box::pin(async move {
            let item=policy::authorize(tx,&actor,&input.id.0,Action::Read,false).await?;
            if enabled && supported(&item) {
                enqueue(tx,&item).await?;
                tx.execute_raw(sql("UPDATE hyori_media_jobs SET state='queued',failure=NULL,failure_detail=NULL,upgrade_retry=false,upgrade_failures=0,due_at=now() WHERE source_key=$1 AND recipe=$2 AND state='failed' AND attempts<6",vec![item.object_key.clone().into(),RECIPE.into()])).await?;
            }
            describe_page(tx,std::slice::from_ref(&item),enabled).await?.pop().ok_or_else(||ApiError::unavailable().into())
        })}).await
    }
}
pub(crate) fn supported(item: &Item) -> bool {
    item.kind == FileKind::File
        && Format::from_mime(&item.mime_type).is_some()
        && item.object_key.is_some()
}
pub(crate) async fn enqueue(tx: &DatabaseTransaction, item: &Item) -> DomainResult<()> {
    enqueue_many(tx, std::slice::from_ref(item)).await
}
pub(crate) async fn enqueue_many(tx: &DatabaseTransaction, items: &[Item]) -> DomainResult<()> {
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let Some(format) = Format::from_mime(&item.mime_type) else {
            continue;
        };
        let fits = item.size > 0 && item.size as u64 <= format.max_source();
        for recipe in
            std::iter::once(RECIPE).chain(matches!(format, Format::Heic).then_some(DISPLAY_RECIPE))
        {
            rows.push(serde_json::json!({"id":random_token(),"owner_id":item.owner_id,"source_key":item.object_key,
                "source_size":item.size,"source_mime":item.mime_type,"recipe":recipe,"fits":fits}));
        }
    }
    tx.execute_raw(sql("INSERT INTO hyori_media_jobs(id,owner_id,source_key,source_size,source_mime,recipe,state,failure)
        SELECT id,owner_id,source_key,source_size,source_mime,recipe,CASE WHEN fits THEN 'queued' ELSE 'unsupported' END,
        CASE WHEN fits THEN NULL ELSE 'resourceLimit' END
        FROM jsonb_to_recordset($1::jsonb) AS rows(id text,owner_id text,source_key text,source_size bigint,source_mime text,recipe integer,fits boolean)
        ON CONFLICT(source_key,recipe) DO NOTHING",vec![serde_json::json!(rows).into()])).await?;
    Ok(())
}

async fn jobs_for(
    tx: &DatabaseTransaction,
    keys: Vec<&str>,
    recipe: i32,
) -> DomainResult<HashMap<String, QueryResult>> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(tx.query_all_raw(sql("SELECT j.*,a.width,a.height,a.state AS artifact_state FROM hyori_media_jobs j
        LEFT JOIN hyori_media_artifacts a ON a.id=j.artifact_id AND a.recipe=j.recipe
        WHERE j.source_key IN (SELECT jsonb_array_elements_text($1::jsonb)) AND j.recipe=$2 LIMIT 100",
        vec![serde_json::json!(keys).into(),recipe.into()])).await?.into_iter()
        .map(|row|Ok((row.try_get::<String>("","source_key")?,row))).collect::<Result<_,sea_orm::DbErr>>()?)
}

pub(crate) async fn describe_page(
    tx: &DatabaseTransaction,
    items: &[Item],
    enabled: bool,
) -> DomainResult<Vec<MediaDerivative>> {
    let keys = items
        .iter()
        .filter_map(|item| item.object_key.as_deref())
        .collect();
    let jobs = jobs_for(tx, keys, RECIPE).await?;
    items
        .iter()
        .map(|item| {
            describe(
                item,
                item.object_key.as_ref().and_then(|key| jobs.get(key)),
                enabled,
            )
        })
        .collect()
}

pub(crate) async fn describe_display_page(
    tx: &DatabaseTransaction,
    items: &[Item],
    enabled: bool,
) -> DomainResult<Vec<Option<DisplayPreview>>> {
    let keys: Vec<_> = items
        .iter()
        .map(|item| match Format::from_mime(&item.mime_type) {
            Some(Format::Heic) => item.object_key.as_deref(),
            _ => None,
        })
        .collect();
    let jobs = jobs_for(tx, keys.iter().copied().flatten().collect(), DISPLAY_RECIPE).await?;
    items
        .iter()
        .zip(keys)
        .map(|(item, key)| {
            let Some(key) = key else { return Ok(None) };
            let preview = if let Some(row) = jobs.get(key) {
                if row.try_get::<String>("", "owner_id")? != item.owner_id {
                    return Err(ApiError::unavailable().into());
                }
                match row.try_get::<String>("", "state")?.as_str() {
                    "ready" => {
                        let (url, width, height) = ready_artifact(item, row)?;
                        DisplayPreview::Ready { url, width, height }
                    }
                    _ if !enabled => DisplayPreview::Unavailable,
                    "queued" => DisplayPreview::Queued,
                    "processing" => DisplayPreview::Processing,
                    _ => DisplayPreview::Failed,
                }
            } else if enabled {
                DisplayPreview::Queued
            } else {
                DisplayPreview::Unavailable
            };
            Ok(Some(preview))
        })
        .collect()
}

fn describe(
    item: &Item,
    row: Option<&QueryResult>,
    enabled: bool,
) -> DomainResult<MediaDerivative> {
    let identity = MediaIdentity {
        kind: if item.mime_type.starts_with("video/") {
            DerivativeKind::Poster
        } else {
            DerivativeKind::Thumbnail
        },
        source_revision: Bytes(item.revision as u64),
    };
    if !supported(item)
        || item.size <= 0
        || Format::from_mime(&item.mime_type)
            .is_none_or(|format| item.size as u64 > format.max_source())
    {
        return Ok(MediaDerivative::Unsupported {
            identity,
            failure: if supported(item) {
                DerivativeFailure::ResourceLimit
            } else {
                DerivativeFailure::Unsupported
            },
        });
    }
    let state = row
        .map(|row| row.try_get::<String>("", "state"))
        .transpose()?
        .unwrap_or_else(|| "queued".into());
    if !enabled && state != "ready" {
        return Ok(MediaDerivative::Unavailable { identity });
    }
    let Some(row) = row else {
        return Ok(MediaDerivative::Queued { identity });
    };
    if row.try_get::<String>("", "owner_id")? != item.owner_id {
        return Err(ApiError::unavailable().into());
    }
    let failure = row
        .try_get::<Option<String>>("", "failure")?
        .map(|value| serde_json::from_value(serde_json::json!(value)))
        .transpose()
        .map_err(|_| ApiError::unavailable())?;
    Ok(match state.as_str() {
        "queued" => MediaDerivative::Queued { identity },
        "processing" => MediaDerivative::Processing { identity },
        "unsupported" => MediaDerivative::Unsupported {
            identity,
            failure: failure.ok_or_else(ApiError::unavailable)?,
        },
        "failed" => MediaDerivative::Failed {
            identity,
            failure: failure.ok_or_else(ApiError::unavailable)?,
            can_retry: row.try_get::<i32>("", "attempts")? < 6,
        },
        "ready" => {
            let (url, width, height) = ready_artifact(item, row)?;
            MediaDerivative::Ready {
                identity,
                url,
                width,
                height,
            }
        }
        _ => return Err(ApiError::unavailable().into()),
    })
}

fn ready_artifact(item: &Item, row: &QueryResult) -> DomainResult<(String, u32, u32)> {
    if row
        .try_get::<Option<String>>("", "artifact_state")?
        .as_deref()
        != Some("ready")
    {
        return Err(ApiError::unavailable().into());
    }
    let artifact: String = row.try_get("", "artifact_id")?;
    Ok((
        format!(
            "/api/storage/derivatives/{}/{artifact}?revision={}",
            item.id, item.revision
        ),
        row.try_get::<i32>("", "width")? as u32,
        row.try_get::<i32>("", "height")? as u32,
    ))
}

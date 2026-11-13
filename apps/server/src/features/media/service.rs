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
use hyori_media_worker::{Format, MAX_INPUT, RECIPE};
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
    let rows:Vec<_>=items.iter().map(|item|serde_json::json!({"id":random_token(),"owner_id":item.owner_id,"source_key":item.object_key,"source_size":item.size,"source_mime":item.mime_type})).collect();
    tx.execute_raw(sql("INSERT INTO hyori_media_jobs(id,owner_id,source_key,source_size,source_mime,recipe,state,failure)
        SELECT id,owner_id,source_key,source_size,source_mime,$2,CASE WHEN source_size BETWEEN 1 AND $3 THEN 'queued' ELSE 'unsupported' END,
        CASE WHEN source_size BETWEEN 1 AND $3 THEN NULL ELSE 'resourceLimit' END
        FROM jsonb_to_recordset($1::jsonb) AS rows(id text,owner_id text,source_key text,source_size bigint,source_mime text)
        ON CONFLICT(source_key,recipe) DO NOTHING",vec![serde_json::json!(rows).into(),RECIPE.into(),(MAX_INPUT as i64).into()])).await?;
    Ok(())
}
pub(crate) async fn describe_page(
    tx: &DatabaseTransaction,
    items: &[Item],
    enabled: bool,
) -> DomainResult<Vec<MediaDerivative>> {
    let keys: Vec<_> = items
        .iter()
        .filter_map(|item| item.object_key.as_deref())
        .collect();
    let jobs=tx.query_all_raw(sql("SELECT j.*,a.size,a.width,a.height,a.state AS artifact_state FROM hyori_media_jobs j LEFT JOIN hyori_media_artifacts a ON a.id=j.artifact_id
        WHERE j.source_key IN (SELECT jsonb_array_elements_text($1::jsonb)) AND j.recipe=$2 LIMIT 100",vec![serde_json::json!(keys).into(),RECIPE.into()])).await?.into_iter().map(|row|Ok((row.try_get::<String>("","source_key")?,row))).collect::<Result<HashMap<_,_>,sea_orm::DbErr>>()?;
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
    if !supported(item) || item.size <= 0 || item.size as u64 > MAX_INPUT {
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
            if row
                .try_get::<Option<String>>("", "artifact_state")?
                .as_deref()
                != Some("ready")
            {
                return Err(ApiError::unavailable().into());
            }
            let artifact: String = row.try_get("", "artifact_id")?;
            MediaDerivative::Ready {
                identity,
                url: format!(
                    "/api/storage/derivatives/{}/{artifact}?revision={}",
                    item.id, item.revision
                ),
                width: row.try_get::<i32>("", "width")? as u32,
                height: row.try_get::<i32>("", "height")? as u32,
            }
        }
        _ => return Err(ApiError::unavailable().into()),
    })
}

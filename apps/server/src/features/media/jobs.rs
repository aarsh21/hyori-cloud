use crate::{
    AppState,
    auth::random_token,
    db::{self, DomainResult, sql},
    error::ApiError,
    features::{
        files::{db::Item, preview::MEDIA},
        media::service,
    },
};
use hyori_media_worker::{Failure, RECIPE, png_dimensions};
use hyori_storage::{Bytes, PartRef};
use sea_orm::{ConnectionTrait, QueryResult};
use std::{sync::Arc, time::Duration};

#[derive(Clone)]
struct Job {
    id: String,
    owner: String,
    source: String,
    size: i64,
    mime: String,
    token: String,
    attempts: i32,
}
impl Job {
    fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            owner: row.try_get("", "owner_id")?,
            source: row.try_get("", "source_key")?,
            size: row.try_get("", "source_size")?,
            mime: row.try_get("", "source_mime")?,
            token: row.try_get("", "lease_token")?,
            attempts: row.try_get("", "attempts")?,
        })
    }
}

/// Items examined per discovery pass. Publication enqueues its own job, so discovery is a
/// bounded safety net for sources that gained bytes another way (restores, copies, upgrades).
const DISCOVERY_PAGE: i64 = 256;

/// One discovery page plus at most one job; no query invokes this command.
pub async fn run_once(state: &Arc<AppState>) -> Result<bool, ApiError> {
    if state.media_worker.is_none() || state.storage.is_none() {
        return Ok(false);
    }
    discover(state).await?;
    process_next(state).await
}
/// Resume an ID-ordered sweep where the last page ended and wrap at the end, so each pass reads
/// a bounded primary-key range instead of scanning every media item for a missing job.
async fn discover(state: &Arc<AppState>) -> Result<(), ApiError> {
    let mut cursor = state.media_discovery.lock().await;
    let after = cursor.clone();
    *cursor = db::domain(&state.db,|tx|{let after=after.clone();Box::pin(async move {
        let page=tx.query_one_raw(sql("SELECT max(id) AS last,count(*)::bigint AS seen FROM (SELECT id FROM hyori_items WHERE id>$1 ORDER BY id LIMIT $2) page",vec![after.clone().into(),DISCOVERY_PAGE.into()])).await?.ok_or_else(ApiError::unavailable)?;
        let Some(last)=page.try_get::<Option<String>>("","last")? else {return Ok(String::new());};
        let seen:i64=page.try_get("","seen")?;
        let items=tx.query_all_raw(sql("SELECT i.* FROM hyori_items i JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
            WHERE i.id>$3 AND i.id<=$4 AND i.kind='file' AND i.trashed_at IS NULL AND i.object_key IS NOT NULL
            AND i.mime_type IN (SELECT jsonb_array_elements_text($1::jsonb))
            AND NOT EXISTS(SELECT 1 FROM hyori_media_jobs j WHERE j.source_key=i.object_key AND j.recipe=$2)
            ORDER BY i.id FOR KEY SHARE OF u",vec![serde_json::json!(MEDIA).into(),RECIPE.into(),after.into(),last.clone().into()])).await?.into_iter().map(Item::from_row).collect::<DomainResult<Vec<_>>>()?;
        service::enqueue_many(tx,&items).await?;
        Ok(if seen<DISCOVERY_PAGE {String::new()} else {last})
    })}).await?;
    Ok(())
}
/// Claim and process the next due job; false when none was due.
pub(crate) async fn process_next(state: &Arc<AppState>) -> Result<bool, ApiError> {
    if state.media_worker.is_none() || state.storage.is_none() {
        return Ok(false);
    }
    let job=db::domain(&state.db,|tx|Box::pin(async move {
        tx.execute_raw(sql("UPDATE hyori_media_jobs SET state='failed',failure='timeout',lease_token=NULL,lease_until=NULL WHERE id IN
            (SELECT id FROM hyori_media_jobs WHERE state='processing' AND lease_until<=now() AND attempts>=3 ORDER BY due_at,id LIMIT 32 FOR UPDATE SKIP LOCKED)",vec![])).await?;
        let row=tx.query_one_raw(sql("SELECT j.id FROM hyori_media_jobs j JOIN hyori_users u ON u.id=j.owner_id AND u.status='active'
            WHERE j.due_at<=now() AND j.attempts<6 AND (j.state='queued' OR (j.state='processing' AND j.lease_until<=now() AND j.attempts<3))
            AND EXISTS(SELECT 1 FROM hyori_items i WHERE i.owner_id=j.owner_id AND i.object_key=j.source_key AND i.trashed_at IS NULL)
            ORDER BY j.due_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED",vec![])).await?;
        let Some(row)=row else {return Ok(None);};
        let id:String=row.try_get("","id")?;
        let claimed=tx.query_one_raw(sql("UPDATE hyori_media_jobs SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1 RETURNING *",vec![id.into(),random_token().into()])).await?.ok_or_else(ApiError::unavailable)?;
        Ok(Some(Job::from_row(claimed)?))
    })).await?;
    let Some(job) = job else {
        return Ok(false);
    };
    let result = tokio::time::timeout(Duration::from_secs(120), process(state, &job))
        .await
        .unwrap_or(Err(Failure::Timeout));
    if let Err(failure) = result {
        let terminal = matches!(
            failure,
            Failure::Unsupported | Failure::InvalidMedia | Failure::ResourceLimit
        );
        let status = if terminal {
            "unsupported"
        } else if job.attempts < 3 {
            "queued"
        } else {
            "failed"
        };
        let failure = serde_json::to_value(failure)
            .map_err(|_| ApiError::unavailable())?
            .as_str()
            .ok_or_else(ApiError::unavailable)?
            .to_owned();
        state.db.execute_raw(sql("UPDATE hyori_media_jobs SET state=$3,failure=$4,lease_token=NULL,lease_until=NULL,due_at=now()+$5::bigint*interval '1 second' WHERE id=$1 AND lease_token=$2",vec![job.id.into(),job.token.into(),status.into(),failure.into(),(10_i64*2_i64.pow(job.attempts as u32)).into()])).await?;
    }
    Ok(true)
}
async fn process(state: &Arc<AppState>, job: &Job) -> Result<(), Failure> {
    let storage = state.storage.as_ref().ok_or(Failure::Unavailable)?;
    let worker = state.media_worker.as_ref().ok_or(Failure::Unavailable)?;
    let source = storage
        .read(&job.source, None)
        .await
        .map_err(|_| Failure::Unavailable)?;
    if source.size != job.size as u64 {
        return Err(Failure::InvalidMedia);
    }
    let bytes = worker.derive(&job.mime, source.size, source.body).await?;
    let (width, height) = png_dimensions(&bytes).ok_or(Failure::InvalidMedia)?;
    let artifact = random_token();
    let key = format!("owners/{}/derivatives/{artifact}", job.owner);
    db::domain(&state.db,|tx|{let (job,artifact,key)=(job.clone(),artifact.clone(),key.clone());Box::pin(async move {
        current(tx,&job).await?;
        tx.execute_raw(sql("INSERT INTO hyori_media_artifacts(id,job_id,owner_id,object_key,state) VALUES ($1,$2,$3,$4,'starting')",vec![artifact.into(),job.id.into(),job.owner.into(),key.into()])).await?;
        Ok(())
    })}).await.map_err(|_|Failure::Unavailable)?;
    let publish=async {
        // The key intent above is committed before every S3 begin; no decoder or storage effect is in a DB retry.
        let multipart=storage.begin(&key,"image/png").await.map_err(|_|Failure::Unavailable)?;
        state.db.execute_raw(sql("UPDATE hyori_media_artifacts SET multipart_id=$2 WHERE id=$1",vec![artifact.clone().into(),multipart.clone().into()])).await.map_err(|_|Failure::Unavailable)?;
        let size=bytes.len() as u64;
        let etag=storage.part(&key,&multipart,1,size,Box::pin(futures_util::stream::once(async move{Ok(Bytes::from(bytes))}))).await.map_err(|_|Failure::Unavailable)?;
        storage.complete(&key,&multipart,&[PartRef{part_number:1,etag}],size).await.map_err(|_|Failure::Unavailable)?;
        db::domain(&state.db,|tx|{let (job,artifact)=(job.clone(),artifact.clone());Box::pin(async move {
            current(tx,&job).await?;
            let changed=tx.execute_raw(sql("UPDATE hyori_media_artifacts SET state='ready',size=$2,width=$3,height=$4,cleanup_due=now(),clean_checks=0 WHERE id=$1 AND state='starting'",vec![artifact.clone().into(),(size as i64).into(),(width as i32).into(),(height as i32).into()])).await?;
            if changed.rows_affected()!=1 {return Err(ApiError::conflict().into());}
            tx.execute_raw(sql("UPDATE hyori_media_jobs SET state='ready',artifact_id=$3,failure=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",vec![job.id.into(),job.token.into(),artifact.into()])).await?;
            Ok(())
        })}).await.map_err(|_|Failure::Unavailable)
    }.await;
    if publish.is_err() {
        // An ambiguous DB acknowledgement may already have published. Never abort a ready artifact.
        let _=state.db.execute_raw(sql("UPDATE hyori_media_artifacts SET state='aborted',cleanup_due=now(),clean_checks=0 WHERE id=$1 AND state<>'ready'",vec![artifact.into()])).await;
    }
    publish
}
async fn current(tx: &sea_orm::DatabaseTransaction, job: &Job) -> DomainResult<()> {
    let owner = tx
        .query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
            vec![job.owner.clone().into()],
        ))
        .await?;
    let current=tx.query_one_raw(sql("SELECT id FROM hyori_media_jobs WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now() FOR UPDATE",vec![job.id.clone().into(),job.token.clone().into()])).await?;
    let source=tx.query_one_raw(sql("SELECT id FROM hyori_items WHERE owner_id=$1 AND object_key=$2 AND trashed_at IS NULL LIMIT 1 FOR SHARE",vec![job.owner.clone().into(),job.source.clone().into()])).await?;
    if owner.is_none() || current.is_none() || source.is_none() {
        return Err(ApiError::conflict().into());
    }
    Ok(())
}

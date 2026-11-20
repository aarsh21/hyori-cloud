use crate::{
    AppState,
    auth::random_token,
    db::{self, DomainResult, sql},
    error::ApiError,
    features::{
        files::{db::Item, preview::MEDIA},
        media::service,
    },
    media_worker::WorkerInput,
};
use futures_util::StreamExt;
use hyori_media_worker::{
    DISPLAY_RECIPE, ErrorBody, Failure, Format, MAX_INPUT, RECIPE, Reason, VIDEO_SAMPLE_HEAD,
    VIDEO_SAMPLE_TAIL, display_dimensions, png_dimensions, webp_dimensions,
};
use hyori_storage::{Bytes, ObjectStorage, PartRef};
use sea_orm::{ConnectionTrait, QueryResult};
use std::{collections::HashMap, sync::Arc, time::Duration};

#[derive(Clone)]
struct Job {
    id: String,
    owner: String,
    source: String,
    size: i64,
    mime: String,
    recipe: i32,
    token: String,
    attempts: i32,
    upgrade_retry: bool,
    revision: Option<String>,
}
impl Job {
    fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            owner: row.try_get("", "owner_id")?,
            source: row.try_get("", "source_key")?,
            size: row.try_get("", "source_size")?,
            mime: row.try_get("", "source_mime")?,
            recipe: row.try_get("", "recipe")?,
            token: row.try_get("", "lease_token")?,
            attempts: row.try_get("", "attempts")?,
            upgrade_retry: row.try_get("", "upgrade_retry")?,
            revision: row.try_get("", "decoder_revision")?,
        })
    }
}

/// Items examined per discovery pass. Publication enqueues its own job, so discovery is a
/// bounded safety net for sources that gained bytes another way (restores, copies, upgrades).
const DISCOVERY_PAGE: i64 = 256;
/// Due jobs one claim examines. Those it can't run wait an hour before being looked at again;
/// restoring from Trash makes them due again (`wake_restored`).
const CLAIM_WINDOW: i64 = 32;

/// Restoring from Trash ends the claim's hourly deferral of the restored items' jobs. Only
/// deferred jobs move, so one still in failure back-off keeps its schedule.
pub(crate) async fn wake_restored(
    tx: &sea_orm::DatabaseTransaction,
    owner: &str,
    root: &str,
) -> DomainResult<()> {
    tx.execute_raw(sql("UPDATE hyori_media_jobs j SET due_at=now(),deferred=false FROM hyori_items i
        WHERE i.owner_id=$1 AND (i.id=$2 OR i.ancestor_ids @> jsonb_build_array($2::text)) AND i.trashed_at IS NULL
        AND j.source_key=i.object_key AND j.owner_id=$1 AND j.state='queued' AND j.deferred",
        vec![owner.into(), root.into()])).await?;
    Ok(())
}

/// One discovery page plus at most one job; no query invokes this command. Without a decoder it
/// only settles expired leases, so a crashed worker's job never keeps a deleted original.
pub async fn run_once(state: &Arc<AppState>) -> Result<bool, ApiError> {
    if state.media_worker.is_none() || state.storage.is_none() {
        return process_next(state).await;
    }
    discover(state).await?;
    process_next(state).await
}
/// Resume an ID-ordered sweep where the last page ended and wrap at the end, so each pass reads
/// a bounded primary-key range instead of scanning every media item for a missing job.
async fn discover(state: &Arc<AppState>) -> Result<(), ApiError> {
    let mut cursor = state.media_discovery.lock().await;
    let after = cursor.clone();
    // Find candidates with a plain read: a serializable sweep over items every tick would make
    // concurrent saves fail serialization. Enqueueing ignores jobs that already exist.
    let page = state.db.query_one_raw(sql("SELECT max(id) AS last,count(*)::bigint AS seen FROM (SELECT id FROM hyori_items WHERE id>$1 ORDER BY id LIMIT $2) page",vec![after.clone().into(),DISCOVERY_PAGE.into()])).await?.ok_or_else(ApiError::unavailable)?;
    let Some(last) = page.try_get::<Option<String>>("", "last")? else {
        cursor.clear();
        return Ok(());
    };
    let seen: i64 = page.try_get("", "seen")?;
    let candidates = state.db.query_all_raw(sql("SELECT i.id FROM hyori_items i
        WHERE i.id>$3 AND i.id<=$4 AND i.kind='file' AND i.trashed_at IS NULL AND i.object_key IS NOT NULL
        AND i.mime_type IN (SELECT jsonb_array_elements_text($1::jsonb))
        AND (NOT EXISTS(SELECT 1 FROM hyori_media_jobs j WHERE j.source_key=i.object_key AND j.recipe=$2)
             OR (i.mime_type IN ('image/heic','image/heif') AND NOT EXISTS(
                 SELECT 1 FROM hyori_media_jobs j WHERE j.source_key=i.object_key AND j.recipe=$5)))
        ORDER BY i.id",vec![serde_json::json!(MEDIA).into(),RECIPE.into(),after.clone().into(),last.clone().into(),DISPLAY_RECIPE.into()])).await?
        .into_iter().map(|row| row.try_get::<String>("", "id")).collect::<Result<Vec<_>, _>>()?;
    if !candidates.is_empty() {
        db::domain(&state.db,|tx|{let ids=serde_json::json!(candidates);Box::pin(async move {
            let items=tx.query_all_raw(sql("SELECT i.* FROM hyori_items i JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                WHERE i.id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND i.kind='file' AND i.trashed_at IS NULL AND i.object_key IS NOT NULL
                AND i.mime_type IN (SELECT jsonb_array_elements_text($1::jsonb))
                ORDER BY i.id FOR KEY SHARE OF u",vec![serde_json::json!(MEDIA).into(),ids.into()])).await?.into_iter().map(Item::from_row).collect::<DomainResult<Vec<_>>>()?;
            service::enqueue_many(tx,&items).await?;
            Ok(())
        })}).await?;
    }
    if let Some(worker) = &state.media_worker
        && let Some(revision) = worker.decoder_revision().await
    {
        super::upgrades::requeue_page(state, &after, &last, &revision).await?;
    }
    *cursor = if seen < DISCOVERY_PAGE {
        String::new()
    } else {
        last
    };
    Ok(())
}
/// Claim and process the next due job; false when nothing was due or settled.
pub(crate) async fn process_next(state: &Arc<AppState>) -> Result<bool, ApiError> {
    if process_derivative(state).await? {
        return Ok(true);
    }
    super::capture::backfill_next(state).await
}

async fn process_derivative(state: &Arc<AppState>) -> Result<bool, ApiError> {
    let runnable = state.media_worker.is_some() && state.storage.is_some();
    let revision = if let Some(worker) = &state.media_worker {
        worker.decoder_revision().await
    } else {
        None
    };
    let (job,settled)=db::domain(&state.db,|tx|{let revision=revision.clone();Box::pin(async move {
        // Only a bounded head is read and locked before anything is classified, so jobs no claim
        // can run never make a claim scan them, or every item. Each one examined is settled so it
        // leaves the head: a source nothing refers to any more can never be reached again, so its
        // job goes (until then it keeps the original from being reclaimed); one only in Trash, or
        // whose owner can't run work, waits; an expired third lease ends the job, and one a
        // reader's Retry started goes back to the queue. The
        // first runnable one is claimed. Without a decoder only expired leases are examined, and
        // a runnable one is released back to the queue.
        let head = if runnable {
            "j.due_at<=now() AND ((j.state='queued' AND j.attempts<6 AND (NOT j.upgrade_retry OR j.decoder_revision=$2)) OR (j.state='processing' AND j.lease_until<=now())) ORDER BY j.upgrade_retry,j.due_at,j.id"
        } else {
            "j.state='processing' AND j.lease_until<=now() ORDER BY j.lease_until,j.id"
        };
        let values = if runnable { vec![CLAIM_WINDOW.into(),revision.clone().into()] } else { vec![CLAIM_WINDOW.into()] };
        let rows=tx.query_all_raw(sql(&format!("WITH c AS MATERIALIZED (SELECT j.id,j.owner_id,j.source_key,j.state,j.attempts,j.due_at,j.lease_until,j.upgrade_retry FROM hyori_media_jobs j WHERE {head} LIMIT $1 FOR UPDATE OF j SKIP LOCKED)
            SELECT c.id,CASE
                WHEN NOT EXISTS(SELECT 1 FROM hyori_items i WHERE i.object_key=c.source_key)
                    AND NOT EXISTS(SELECT 1 FROM hyori_versions v WHERE v.object_key=c.source_key) THEN 'retire'
                WHEN c.state='processing' AND (c.upgrade_retry OR c.attempts>3) THEN 'retry_upgrade'
                WHEN c.state='processing' AND c.attempts>=3 THEN 'timeout'
                WHEN EXISTS(SELECT 1 FROM hyori_users u WHERE u.id=c.owner_id AND u.status='active')
                    AND EXISTS(SELECT 1 FROM hyori_items i WHERE i.owner_id=c.owner_id AND i.object_key=c.source_key AND i.trashed_at IS NULL) THEN 'claim'
                ELSE 'defer' END AS action
            FROM c ORDER BY c.upgrade_retry,c.due_at,c.lease_until,c.id"),values)).await?;
        let mut claim=None;
        let mut settle:HashMap<String,Vec<String>>=HashMap::new();
        for row in rows {
            let (id,action)=(row.try_get::<String>("","id")?,row.try_get::<String>("","action")?);
            match action.as_str() {
                "claim" if !runnable => settle.entry("release".into()).or_default().push(id),
                "claim" if claim.is_none() => claim=Some(id),
                "claim" => {}
                _ => settle.entry(action).or_default().push(id),
            }
        }
        let retry_upgrade=format!("UPDATE hyori_media_jobs SET {},failure='timeout',failure_detail=NULL WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",super::upgrades::TRANSIENT_UPDATE);
        for (action,statement) in [
            ("retire","DELETE FROM hyori_media_jobs WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))"),
            ("retry_upgrade",retry_upgrade.as_str()),
            ("timeout","UPDATE hyori_media_jobs SET state='failed',failure='timeout',lease_token=NULL,lease_until=NULL WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))"),
            ("defer","UPDATE hyori_media_jobs SET state='queued',lease_token=NULL,lease_until=NULL,due_at=now()+interval '1 hour',deferred=true WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))"),
            ("release","UPDATE hyori_media_jobs SET state='queued',lease_token=NULL,lease_until=NULL WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))"),
        ] {
            if let Some(ids)=settle.get(action) {
                tx.execute_raw(sql(statement,vec![serde_json::json!(ids).into()])).await?;
            }
        }
        let settled=!settle.is_empty();
        let Some(id)=claim else {return Ok((None,settled));};
        let claimed=tx.query_one_raw(sql("UPDATE hyori_media_jobs SET state='processing',attempts=attempts+1,deferred=false,decoder_revision=$3,lease_token=$2,lease_until=now()+interval '5 minutes' WHERE id=$1 RETURNING *",vec![id.into(),random_token().into(),revision.into()])).await?.ok_or_else(ApiError::unavailable)?;
        Ok((Some(Job::from_row(claimed)?),settled))
    })}).await?;
    let Some(job) = job else {
        // Settling the head is progress: the next claim reaches what was waiting behind it.
        return Ok(settled);
    };
    let result = tokio::time::timeout(Duration::from_secs(120), process(state, &job))
        .await
        .unwrap_or(Err(Failure::Timeout.into()));
    if let Err(error) = result {
        let failure = error.error;
        let terminal = matches!(
            failure,
            Failure::Unsupported | Failure::InvalidMedia | Failure::ResourceLimit
        );
        // Only a diagnosed stage deadline proves decoding ran; bare timeouts can be transfer stalls.
        let decoder_deadline = failure == Failure::Timeout
            && error
                .diagnostic
                .is_some_and(|d| matches!(d.reason, Reason::Deadline));
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
        let detail = error
            .diagnostic
            .map(serde_json::to_value)
            .transpose()
            .map_err(|_| ApiError::unavailable())?;
        tracing::warn!(job_id=%job.id, failure=%failure, diagnostic=?error.diagnostic, "media derivation failed");
        // Attempts past the third exist only because a reader pressed Retry. Like an upgrade
        // retry, such an attempt is spent by a decoder verdict, never by an outage: otherwise
        // three presses while storage or the worker is down end the job with no Retry left.
        let released = job.upgrade_retry || job.attempts > 3;
        if released && !terminal && !decoder_deadline {
            state.db.execute_raw(sql(&format!("UPDATE hyori_media_jobs SET {},failure=$3,failure_detail=$4 WHERE id=$1 AND lease_token=$2",super::upgrades::TRANSIENT_UPDATE),vec![job.id.into(),job.token.into(),failure.into(),detail.into()])).await?;
        } else {
            state.db.execute_raw(sql("UPDATE hyori_media_jobs SET state=$3,failure=$4,failure_detail=$6,lease_token=NULL,lease_until=NULL,due_at=now()+$5::bigint*interval '1 second' WHERE id=$1 AND lease_token=$2",vec![job.id.into(),job.token.into(),status.into(),failure.into(),(10_i64*2_i64.pow(job.attempts as u32)).into(),detail.into()])).await?;
        }
    }
    Ok(true)
}
pub(super) async fn read_source(
    storage: &ObjectStorage,
    key: &str,
    mime: &str,
    size: u64,
    length: u64,
) -> Result<WorkerInput, ErrorBody> {
    let format = Format::from_mime(mime).ok_or(Failure::Unsupported)?;
    if size == 0 || size > format.max_source() {
        return Err(Failure::ResourceLimit.into());
    }
    if size > MAX_INPUT {
        // The worker receives just two immutable ranges, with their original offsets implicit.
        // WebM normally needs the head; MOV/MP4 can carry the index at either end.
        let head = storage
            .read(key, Some(&format!("bytes=0-{}", VIDEO_SAMPLE_HEAD - 1)))
            .await
            .map_err(|_| Failure::Unavailable)?;
        let tail = storage
            .read(
                key,
                Some(&format!("bytes={}-{}", size - VIDEO_SAMPLE_TAIL, size - 1)),
            )
            .await
            .map_err(|_| Failure::Unavailable)?;
        if head.size != VIDEO_SAMPLE_HEAD
            || tail.size != VIDEO_SAMPLE_TAIL
            || [head.content_range, tail.content_range]
                .iter()
                .any(|range| {
                    range
                        .as_deref()
                        .and_then(|range| range.rsplit_once('/'))
                        .and_then(|(_, size)| size.parse::<u64>().ok())
                        != Some(size)
                })
        {
            return Err(Failure::Unavailable.into());
        }
        return Ok(WorkerInput {
            size: VIDEO_SAMPLE_HEAD + VIDEO_SAMPLE_TAIL,
            body: Box::pin(head.body.chain(tail.body)),
            sampled_source_size: Some(size),
        });
    }
    let range = (length < size).then(|| format!("bytes=0-{}", length - 1));
    let source = storage
        .read(key, range.as_deref())
        .await
        .map_err(|_| Failure::Unavailable)?;
    if source.size != length {
        return Err(Failure::Unavailable.into());
    }
    Ok(WorkerInput {
        size: length,
        body: source.body,
        sampled_source_size: None,
    })
}

async fn process(state: &Arc<AppState>, job: &Job) -> Result<(), ErrorBody> {
    let storage = state.storage.as_ref().ok_or(Failure::Unavailable)?;
    let worker = state.media_worker.as_ref().ok_or(Failure::Unavailable)?;
    let source = read_source(
        storage,
        &job.source,
        &job.mime,
        job.size as u64,
        job.size as u64,
    )
    .await?;
    let display = job.recipe == DISPLAY_RECIPE;
    let (bytes, mime, capture) = worker
        .derive(&job.mime, source, job.revision.as_deref(), display)
        .await?;
    let (width, height) = if display {
        display_dimensions(&bytes)
    } else if mime == "image/webp" {
        webp_dimensions(&bytes)
    } else {
        png_dimensions(&bytes)
    }
    .ok_or(Failure::InvalidMedia)?;
    let artifact = random_token();
    // Persist the format in the server-owned immutable key, without rewriting legacy PNG rows.
    let extension = if mime == "image/webp" { "_webp" } else { "" };
    let key = format!("owners/{}/derivatives/{artifact}{extension}", job.owner);
    db::domain(&state.db,|tx|{let (job,artifact,key)=(job.clone(),artifact.clone(),key.clone());Box::pin(async move {
        current(tx,&job).await?;
        tx.execute_raw(sql("INSERT INTO hyori_media_artifacts(id,job_id,owner_id,object_key,state,recipe) VALUES ($1,$2,$3,$4,'starting',$5)",vec![artifact.into(),job.id.into(),job.owner.into(),key.into(),job.recipe.into()])).await?;
        Ok(())
    })}).await.map_err(|_|Failure::Unavailable)?;
    let publish=async {
        // The key intent above is committed before every S3 begin; no decoder or storage effect is in a DB retry.
        let multipart=storage.begin(&key,mime).await.map_err(|_|Failure::Unavailable)?;
        state.db.execute_raw(sql("UPDATE hyori_media_artifacts SET multipart_id=$2 WHERE id=$1",vec![artifact.clone().into(),multipart.clone().into()])).await.map_err(|_|Failure::Unavailable)?;
        let size=bytes.len() as u64;
        let etag=storage.part(&key,&multipart,1,size,Box::pin(futures_util::stream::once(async move{Ok(Bytes::from(bytes))}))).await.map_err(|_|Failure::Unavailable)?;
        storage.complete(&key,&multipart,&[PartRef{part_number:1,etag}],size).await.map_err(|_|Failure::Unavailable)?;
        db::domain(&state.db,|tx|{let (job,artifact,capture)=(job.clone(),artifact.clone(),capture.clone());Box::pin(async move {
            current(tx,&job).await?;
            let changed=tx.execute_raw(sql("UPDATE hyori_media_artifacts SET state='ready',size=$2,width=$3,height=$4,cleanup_due=now(),clean_checks=0 WHERE id=$1 AND state='starting'",vec![artifact.clone().into(),(size as i64).into(),(width as i32).into(),(height as i32).into()])).await?;
            if changed.rows_affected()!=1 {return Err(ApiError::conflict().into());}
            if let Some(capture) = capture {
                super::capture::record(tx, &job.owner, &job.source, &job.mime, None, capture).await?;
            }
            tx.execute_raw(sql("UPDATE hyori_media_jobs SET state='ready',artifact_id=$3,failure=NULL,failure_detail=NULL,upgrade_retry=false,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",vec![job.id.into(),job.token.into(),artifact.into()])).await?;
            Ok(())
        })}).await.map_err(|_|Failure::Unavailable)
    }.await;
    if publish.is_err() {
        // An ambiguous DB acknowledgement may already have published. Never abort a ready artifact.
        let _=state.db.execute_raw(sql("UPDATE hyori_media_artifacts SET state='aborted',cleanup_due=now(),clean_checks=0 WHERE id=$1 AND state<>'ready'",vec![artifact.into()])).await;
    }
    publish.map_err(Into::into)
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

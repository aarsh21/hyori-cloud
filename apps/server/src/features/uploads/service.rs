use crate::{
    AppState,
    auth::{digest, random_token},
    db::{self, sql},
    error::ApiError,
    features::{
        auth::api::Done,
        files::{
            api::{FileEntry, FileKind},
            db::{Item, Version},
            policy as files,
        },
        uploads::{api::*, db::Upload, policy},
    },
    rpc::RequestContext,
};
use chrono::Utc;
use futures_util::StreamExt;
use hyori_storage::{CHUNK_SIZE, MAX_PARTS, ObjectStorage, StorageError, StorageStream};
use sea_orm::ConnectionTrait;
use std::{future::Future, sync::Arc, time::Duration};
use tokio::sync::OwnedSemaphorePermit;
use tracing::Instrument;

pub(crate) fn storage_error(_: StorageError) -> ApiError {
    ApiError::unavailable()
}
pub(crate) struct UploadsService {
    state: Arc<AppState>,
    context: RequestContext,
}
impl UploadsService {
    pub fn new(state: Arc<AppState>, context: RequestContext) -> Self {
        Self { state, context }
    }
    fn storage(&self) -> Result<&ObjectStorage, ApiError> {
        self.state
            .storage
            .as_ref()
            .ok_or_else(ApiError::unavailable)
    }
    /// Which owner's lock to queue on. Nothing read here authorizes anything: the transaction
    /// that follows decides that, and a wrong or missing guess only brings back a retry.
    async fn owner_hint(&self, query: &str, value: String) -> Option<String> {
        let row = self
            .state
            .db
            .query_one_raw(sql(query, vec![value.into()]))
            .await;
        row.ok().flatten()?.try_get("", "owner_id").ok()
    }
    /// Every upload transaction of one owner queues on its lock first; see `db::OwnerLocks`.
    async fn owner_domain<T, F>(&self, owner: Option<&str>, operation: F) -> Result<T, ApiError>
    where
        T: Send,
        F: for<'a> Fn(&'a sea_orm::DatabaseTransaction) -> db::DomainFuture<'a, T>,
    {
        let _queued = self.state.owner_locks.lock(owner).await;
        db::domain(&self.state.db, operation).await
    }
    pub async fn begin(&self, input: BeginUpload) -> Result<UploadStatus, ApiError> {
        let storage = self.storage()?;
        let _permit = self
            .state
            .transfers
            .try_acquire()
            .map_err(|_| ApiError::unavailable())?;
        if input.size.0 > CHUNK_SIZE * u64::from(MAX_PARTS) {
            return Err(ApiError::invalid());
        }
        let name = files::normalize_name(&input.name.0)?;
        let mime = if input.mime_type.is_empty() {
            "application/octet-stream".to_owned()
        } else {
            input.mime_type.clone()
        };
        if !mime.is_ascii() || mime.bytes().any(|b| b.is_ascii_control()) {
            return Err(ApiError::invalid());
        }
        let id = random_token();
        let hint = match input.replace_id.as_ref().or(input.parent_id.0.as_ref()) {
            Some(item) => {
                let query = "SELECT owner_id FROM hyori_items WHERE id=$1";
                self.owner_hint(query, item.0.clone()).await
            }
            None => match &self.context.session {
                Some(token) => {
                    let query =
                        "SELECT user_id AS owner_id FROM hyori_sessions WHERE token_digest=$1";
                    self.owner_hint(query, digest(token)).await
                }
                None => None,
            },
        };
        let upload = self
            .owner_domain(hint.as_deref(), |tx| {
                let (context, mut input, id) = (self.context.clone(), input.clone(), id.clone());
                input.name.0 = name.clone();
                input.mime_type = mime.clone();
                Box::pin(async move { reserve(tx, &context, &input, &id).await })
            })
            .instrument(tracing::info_span!("upload_reservation"))
            .await?;
        // No automatic replay. Timeout/lost response leaves the starting intent for cleanup.
        let multipart = storage
            .begin(&upload.object_key, &upload.mime_type)
            .await
            .map_err(storage_error)?;
        self.owner_domain(hint.as_deref(), |tx| {
            let assets = self.state.editor_assets.clone();
            let (context,id,multipart) = (self.context.clone(),id.clone(),multipart.clone());
            Box::pin(async move {
                let (upload,_) = policy::checked(tx,&assets,&context,&id).await?;
                if upload.state != "starting" { return Err(ApiError::conflict().into()); }
                tx.execute_raw(sql("UPDATE hyori_uploads SET multipart_id=$2,state='uploading',cleanup_due=expires_at WHERE id=$1",vec![id.clone().into(),multipart.into()])).await?;
                Upload::get(tx,&id).await?.status(tx).await
            })
        }).await
    }
    /// A stable editor save ID owns this committed key intent before any multipart begin.
    pub(crate) async fn start_reserved(&self, id: &str) -> Result<UploadStatus, ApiError> {
        let storage = self.storage()?;
        let _permit = self
            .state
            .transfers
            .try_acquire()
            .map_err(|_| ApiError::unavailable())?;
        let token = random_token();
        let upload = db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, id, token) = (self.context.clone(), id.to_owned(), token.clone());
            Box::pin(async move {
                let (upload, _) = policy::checked(tx, &assets, &context, &id).await?;
                if upload.state == "starting" {
                    if upload.expires_at <= Utc::now() {
                        return Err(ApiError::conflict().into());
                    }
                    claim(tx, &upload, &token, "starting").await?;
                }
                Ok(upload)
            })
        })
        .await?;
        if upload.state == "starting" {
            let multipart = match storage.begin(&upload.object_key, &upload.mime_type).await {
                Ok(multipart) => multipart,
                Err(error) => {
                    self.release(id, &token).await;
                    return Err(storage_error(error));
                }
            };
            let recorded = db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
                let (context, id, token, multipart) = (self.context.clone(), id.to_owned(), token.clone(), multipart.clone());
                Box::pin(async move {
                    let (upload, _) = policy::checked(tx,&assets, &context, &id).await?;
                    if upload.state != "starting" || upload.lease_token.as_deref() != Some(&token) { return Err(ApiError::conflict().into()); }
                    tx.execute_raw(sql("UPDATE hyori_uploads SET multipart_id=$2,state='uploading',lease_token=NULL,lease_until=NULL,cleanup_due=expires_at WHERE id=$1", vec![id.into(),multipart.into()])).await?;
                    Ok(())
                })
            }).await;
            if recorded.is_err() {
                self.release(id, &token).await;
            }
            recorded?;
        }
        self.status(UploadInput {
            upload_id: crate::features::auth::api::Id(id.into()),
        })
        .await
    }
    pub async fn status(&self, input: UploadInput) -> Result<UploadStatus, ApiError> {
        self.storage()?;
        db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, id) = (self.context.clone(), input.upload_id.0.clone());
            Box::pin(async move {
                policy::checked(tx, &assets, &context, &id)
                    .await?
                    .0
                    .status(tx)
                    .await
            })
        })
        .await
    }
    pub async fn part(&self, input: UploadPartInput) -> Result<UploadPart, ApiError> {
        self.storage()?;
        db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, input) = (self.context.clone(), input.clone());
            Box::pin(async move {
                let (upload, _) =
                    policy::checked(tx, &assets, &context, &input.upload_id.0).await?;
                upload.part_size(input.part_number)?;
                if upload.state != "uploading" || upload.expires_at <= Utc::now() {
                    return Err(ApiError::conflict().into());
                }
                Ok(UploadPart {
                    url: format!("/api/storage/uploads/{}/{}", upload.id, input.part_number),
                    method: PutMethod::Put,
                    headers: Default::default(),
                })
            })
        })
        .await
    }
    pub async fn write_part(
        &self,
        id: String,
        number: u32,
        length: u64,
        body: StorageStream,
        permit: OwnedSemaphorePermit,
    ) -> Result<UploadStatus, ApiError> {
        self.run_leased(id.clone(), permit, move |service, token| async move {
            service
                .write_part_leased(id, number, length, body, token)
                .await
        })
        .await
    }
    async fn write_part_leased(
        &self,
        id: String,
        number: u32,
        length: u64,
        mut body: StorageStream,
        token: String,
    ) -> Result<UploadStatus, ApiError> {
        let storage = self.storage()?;
        let owner = self
            .owner_hint("SELECT owner_id FROM hyori_uploads WHERE id=$1", id.clone())
            .await;
        let (upload,acknowledged) = self.owner_domain(owner.as_deref(), |tx| {
            let assets = self.state.editor_assets.clone(); let (context,id,token)=(self.context.clone(),id.clone(),token.clone()); Box::pin(async move {
            let (upload,_) = policy::checked(tx,&assets,&context,&id).await?;
            if upload.state != "uploading" || upload.expires_at <= Utc::now() { return Err(ApiError::conflict().into()); }
            if upload.part_size(number)? != length { return Err(ApiError::invalid().into()); }
            let acknowledged = tx.query_one_raw(sql("SELECT size,etag FROM hyori_upload_parts WHERE upload_id=$1 AND part_number=$2",vec![id.clone().into(),(number as i32).into()])).await?;
            if let Some(part) = acknowledged {
                if part.try_get::<i64>("","size")? != length as i64 || part.try_get::<String>("","etag")?.is_empty() { return Err(ApiError::conflict().into()); }
                return Ok((upload,true));
            }
            claim(tx,&upload,&token,"uploading").await?;
            Ok((upload,false))
        }) }).await?;
        let checksum = if upload.editor_bound {
            let (hashed_body, digest) = crate::features::editors::ingest::PartDigest::wrap(body);
            body = hashed_body;
            Some(digest)
        } else {
            None
        };
        let transferred = if acknowledged {
            // A durable acknowledgement is immutable: replay drains/validates without rewriting S3.
            let mut remaining = length;
            while let Some(chunk) = body.next().await {
                let chunk = chunk.map_err(storage_error)?;
                remaining = remaining
                    .checked_sub(chunk.len() as u64)
                    .ok_or_else(ApiError::invalid)?;
            }
            if remaining != 0 {
                return Err(ApiError::invalid());
            }
            Ok(None)
        } else {
            storage
                .part(
                    &upload.object_key,
                    upload
                        .multipart_id
                        .as_deref()
                        .ok_or_else(ApiError::conflict)?,
                    number as u16,
                    length,
                    body,
                )
                .await
                .map(Some)
                .map_err(storage_error)
        };
        let etag = match transferred {
            Ok(etag) => etag,
            Err(error) => {
                self.release(&id, &token).await;
                return Err(error);
            }
        };
        let checksum = match checksum.map(|digest| digest.finish()).transpose() {
            Ok(value) => value,
            Err(error) => {
                self.release(&id, &token).await;
                return Err(error);
            }
        };
        let recorded = self.owner_domain(owner.as_deref(), |tx| {
            let assets = self.state.editor_assets.clone(); let (context,id,token,etag,checksum)=(self.context.clone(),id.clone(),token.clone(),etag.clone(),checksum.clone()); Box::pin(async move {
            let (current,_) = policy::checked(tx,&assets,&context,&id).await?;
            if current.state != "uploading" || current.expires_at <= Utc::now() { return Err(ApiError::conflict().into()); }
            if let Some(etag) = etag {
                if current.lease_token.as_deref() != Some(&token) { return Err(ApiError::conflict().into()); }
                tx.execute_raw(sql("INSERT INTO hyori_upload_parts(upload_id,part_number,size,etag,editor_sha256) VALUES ($1,$2,$3,$4,$5)",vec![id.clone().into(),(number as i32).into(),(length as i64).into(),etag.into(),checksum.into()])).await?;
                tx.execute_raw(sql("UPDATE hyori_uploads SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",vec![id.into(),token.into()])).await?;
            } else if let Some(checksum) = checksum {
                let stored = tx.query_one_raw(sql("SELECT editor_sha256 FROM hyori_upload_parts WHERE upload_id=$1 AND part_number=$2",vec![id.into(),(number as i32).into()])).await?.ok_or_else(ApiError::conflict)?;
                if stored.try_get::<Option<String>>("","editor_sha256")?.as_deref() != Some(&checksum) { return Err(ApiError::invalid().into()); }
            }
            current.status(tx).await
        }) }).instrument(tracing::info_span!("upload_part_acknowledgement")).await;
        if recorded.is_err() && !acknowledged {
            self.release(&id, &token).await;
        }
        recorded
    }
    // A request disconnect (or the RPC deadline) must not cancel a committed lease's owner.
    // Admission happens before spawn; its permit remains owned through completion and release.
    async fn run_leased<T, F, W>(
        &self,
        id: String,
        permit: OwnedSemaphorePermit,
        operation: F,
    ) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(Self, String) -> W + Send + 'static,
        W: Future<Output = Result<T, ApiError>> + Send + 'static,
    {
        let service = Self::new(self.state.clone(), self.context.clone());
        let worker = Self::new(self.state.clone(), self.context.clone());
        let token = random_token();
        tokio::spawn(
            async move {
                let _permit = permit;
                match tokio::time::timeout(
                    Duration::from_secs(125),
                    operation(worker, token.clone()),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        service.release(&id, &token).await;
                        Err(ApiError::unavailable())
                    }
                }
            }
            .in_current_span(),
        )
        .await
        .map_err(|_| ApiError::unavailable())?
    }
    async fn release(&self, id: &str, token: &str) {
        let released = tokio::time::timeout(Duration::from_secs(5), async {
            // Transaction-local limits also bound SQL still executing after local cancellation.
            let tx = db::begin(&self.state.db).await?;
            tx.execute_raw(sql("UPDATE hyori_uploads SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",vec![id.into(),token.into()])).await?;
            tx.commit().await?;
            Ok::<_, ApiError>(())
        }).await;
        if !matches!(released, Ok(Ok(()))) {
            tracing::warn!("upload lease release failed; expiry will recover it");
        }
    }
    #[tracing::instrument(skip_all, name = "upload_completion")]
    pub async fn complete(&self, input: UploadInput) -> Result<FileEntry, ApiError> {
        self.storage()?;
        let permit = self
            .state
            .transfers
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::unavailable())?;
        self.run_leased(
            input.upload_id.0.clone(),
            permit,
            move |service, token| async move { service.complete_leased(input, token).await },
        )
        .await
    }
    async fn complete_leased(
        &self,
        input: UploadInput,
        token: String,
    ) -> Result<FileEntry, ApiError> {
        let storage = self.storage()?;
        let id = input.upload_id.0;
        // An upload's owner never changes, so one lookup serves both transactions.
        let owner = self
            .owner_hint("SELECT owner_id FROM hyori_uploads WHERE id=$1", id.clone())
            .await;
        let (upload, parts) = self
            .owner_domain(owner.as_deref(), |tx| {
                let assets = self.state.editor_assets.clone();
                let (context, id, token) = (self.context.clone(), id.clone(), token.clone());
                Box::pin(async move {
                    let (upload, _) = policy::checked(tx, &assets, &context, &id).await?;
                    if upload.state == "complete" {
                        return Ok((upload, vec![]));
                    }
                    if !matches!(upload.state.as_str(), "uploading" | "finalizing")
                        || upload.expires_at <= Utc::now()
                    {
                        return Err(ApiError::conflict().into());
                    }
                    policy::quota(tx, &upload.owner_id, 0).await?;
                    files::available_name(
                        tx,
                        &upload.owner_id,
                        upload.parent_id.as_deref(),
                        &upload.name,
                        upload.replace_id.as_deref(),
                    )
                    .await?;
                    let parts = upload.parts(tx).await?;
                    if parts.len() as u64 != upload.total_parts()
                        || parts.iter().enumerate().any(|(i, (p, size))| {
                            usize::from(p.part_number) != i + 1
                                || upload.part_size(u32::from(p.part_number)).ok() != Some(*size)
                        })
                    {
                        return Err(ApiError::conflict().into());
                    }
                    claim(tx, &upload, &token, "finalizing").await?;
                    Ok((
                        upload,
                        parts.into_iter().map(|(p, _)| p).collect::<Vec<_>>(),
                    ))
                })
            })
            .await?;
        if upload.state == "complete" {
            return terminal(&upload);
        }
        let result = storage
            .complete(
                &upload.object_key,
                upload
                    .multipart_id
                    .as_deref()
                    .ok_or_else(ApiError::conflict)?,
                &parts,
                upload.size as u64,
            )
            .await;
        if let Err(error) = result {
            self.release(&id, &token).await;
            return Err(storage_error(error));
        }
        if let Err(error) =
            crate::features::editors::service::validate_upload(&self.state, &upload).await
        {
            self.release(&id, &token).await;
            if error.code == crate::error::ErrorCode::InvalidInput {
                self.abort(UploadInput {
                    upload_id: crate::features::auth::api::Id(id.clone()),
                })
                .await?;
            }
            return Err(error);
        }
        let published = self.owner_domain(owner.as_deref(), |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, id, token) = (self.context.clone(), id.clone(), token.clone());
            Box::pin(async move {
                let (current, actor) = policy::checked(tx,&assets, &context, &id).await?;
                if current.state == "complete" {
                    return terminal(&current).map_err(Into::into);
                }
                if current.state != "finalizing"
                    || current.lease_token.as_deref() != Some(&token)
                    || current.expires_at <= Utc::now()
                {
                    return Err(ApiError::conflict().into());
                }
                policy::quota(tx, &current.owner_id, 0).await?;
                let (destination, previous) = policy::destination(
                    tx, &actor, current.parent_id.as_deref(), current.replace_id.as_deref(),
                ).await?;
                files::available_name(
                    tx, &current.owner_id, current.parent_id.as_deref(),
                    &current.name, current.replace_id.as_deref(),
                ).await?;
                let now = Utc::now();
                if let Some(previous) = &previous
                    && crate::features::editors::history::checkpoint(tx, &current, previous).await? {
                    Version {
                        id: random_token(),
                        file_id: previous.id.clone(),
                        owner_id: previous.owner_id.clone(),
                        object_key: previous.object_key.clone().ok_or_else(ApiError::conflict)?,
                        size: previous.size,
                        mime_type: previous.mime_type.clone(),
                        created_at: now,
                    }.save(tx).await?;
                }
                let mut item = Item {
                    share_role: None,
                    id: previous.as_ref().map(|p| p.id.clone()).unwrap_or_else(random_token),
                    owner_id: current.owner_id.clone(),
                    parent_id: current.parent_id.clone(),
                    name: current.name.clone(),
                    kind: FileKind::File,
                    size: current.size,
                    mime_type: current.mime_type.clone(),
                    object_key: Some(current.object_key.clone()),
                    uploaded_by: current.uploader_id.clone(),
                    ancestor_ids: destination.ancestor_ids,
                    revision: previous.as_ref().map_or(0, |p| p.revision + 1),
                    trash_root: None,
                    trashed_at: None,
                    created_at: previous.as_ref().map_or(now, |p| p.created_at),
                    updated_at: now,
                };
                if previous.is_some() {
                    item.save(tx).await?;
                    tx.execute_raw(sql(
                        "UPDATE hyori_items SET uploaded_by=$2 WHERE id=$1",
                        vec![item.id.clone().into(), item.uploaded_by.clone().into()],
                    )).await?;
                } else {
                    item.insert(tx).await?;
                }
                tx.execute_raw(sql(
                    "INSERT INTO hyori_objects(object_key,owner_id,size) VALUES ($1,$2,$3)",
                    vec![current.object_key.clone().into(), current.owner_id.clone().into(), current.size.into()],
                )).await?;
                tx.execute_raw(sql(
                    "UPDATE hyori_users SET reserved_bytes=reserved_bytes-$2,used_bytes=used_bytes+$2 WHERE id=$1",
                    vec![current.owner_id.clone().into(), current.size.into()],
                )).await?;
                files::load_roles(tx, &actor, std::slice::from_mut(&mut item)).await?;
                let result = files::project(&item, &actor);
                crate::features::editors::policy::published(tx, &current, &item, &result).await?;
                tx.execute_raw(sql(
                    "UPDATE hyori_uploads SET state='complete',reservation_held=false,file_id=$2,result=$3,
                     lease_token=NULL,lease_until=NULL,cleanup_due=now() WHERE id=$1",
                    vec![id.into(), item.id.into(), serde_json::to_value(&result).map_err(|_| ApiError::unavailable())?.into()],
                )).await?;
                Ok(result)
            })
        }).instrument(tracing::info_span!("upload_publication")).await;
        if published.is_err() {
            // The immutable object may already exist; release only our fenced lease for replay.
            self.release(&id, &token).await;
        } else {
            // Cleanup never extends save latency; maintenance also retries after restart/outages.
            self.state.upload_cleanup.notify_one();
        }
        published
    }
    pub async fn abort(&self, input: UploadInput) -> Result<Done, ApiError> {
        self.storage()?;
        db::domain(&self.state.db, |tx| {
            let (context, id) = (self.context.clone(), input.upload_id.0.clone());
            Box::pin(async move {
                // Cancelling one's own intent cannot publish bytes; changed destination/revision
                // must not trap a still-authenticated initiator's reservation until expiry.
                let (upload, _) = policy::initiated(tx, &context, &id).await?;
                upload.abort(tx).await?;
                Ok(Done { success: true })
            })
        })
        .await
    }
}
pub(crate) async fn reserve(
    tx: &sea_orm::DatabaseTransaction,
    context: &RequestContext,
    input: &BeginUpload,
    id: &str,
) -> db::DomainResult<Upload> {
    let actor = files::resolve_actor(tx, context).await?;
    let parent = input.parent_id.0.as_ref().map(|id| id.0.as_str());
    let replacement = input.replace_id.as_ref().map(|id| id.0.as_str());
    let (destination, previous) = policy::destination(tx, &actor, parent, replacement).await?;
    if previous.as_ref().is_some_and(|p| p.name != input.name.0) {
        return Err(ApiError::invalid().into());
    }
    files::available_name(
        tx,
        &destination.owner_id,
        parent,
        &input.name.0,
        replacement,
    )
    .await?;
    policy::quota(tx, &destination.owner_id, input.size.0 as i64).await?;
    let pending = tx
        .query_one_raw(sql(
            "SELECT pending_uploads FROM hyori_users WHERE id=$1",
            vec![destination.owner_id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::unavailable)?
        .try_get::<i32>("", "pending_uploads")?;
    if pending >= 128 {
        return Err(ApiError::conflict().into());
    }
    // Inventory and full reservation commit before any storage effect.
    tx.execute_raw(sql(
        "INSERT INTO hyori_uploads(id,owner_id,uploader_id,grant_digests,parent_id,name,size,mime_type,object_key,replace_id,replace_revision,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'starting')",
        vec![id.into(), destination.owner_id.clone().into(), actor.user_id().into(),
            serde_json::json!(context.grants.iter().map(|t| digest(t)).collect::<Vec<_>>()).into(),
            parent.into(), input.name.0.clone().into(), (input.size.0 as i64).into(), input.mime_type.clone().into(),
            format!("owners/{}/{id}",destination.owner_id).into(), replacement.into(), previous.map(|p| p.revision).into()],
    )).await?;
    tx.execute_raw(sql(
        "UPDATE hyori_users SET reserved_bytes=reserved_bytes+$2 WHERE id=$1",
        vec![destination.owner_id.into(), (input.size.0 as i64).into()],
    ))
    .await?;
    Upload::get(tx, id).await
}
fn terminal(upload: &Upload) -> Result<FileEntry, ApiError> {
    serde_json::from_value(upload.result.clone().ok_or_else(ApiError::unavailable)?)
        .map_err(|_| ApiError::unavailable())
}
async fn claim(
    tx: &sea_orm::DatabaseTransaction,
    upload: &Upload,
    token: &str,
    state: &str,
) -> db::DomainResult<()> {
    let changed = tx.execute_raw(sql("UPDATE hyori_uploads SET state=$3,lease_token=$2,lease_until=now()+interval '3 minutes' WHERE id=$1 AND (lease_until IS NULL OR lease_until<=now())",vec![upload.id.clone().into(),token.into(),state.into()])).await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::conflict().into());
    }
    Ok(())
}

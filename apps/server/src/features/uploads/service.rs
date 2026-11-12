use crate::{
    AppState,
    auth::{digest, random_token},
    db::{self, sql},
    error::{ApiError, ErrorCode},
    features::{
        auth::api::Done,
        files::{
            api::{FileEntry, FileKind},
            db::{Item, Version},
            policy as files,
        },
        uploads::{
            admission::{self, Admission},
            api::*,
            db::Upload,
            policy,
        },
    },
    rpc::RequestContext,
};
use chrono::Utc;
use futures_util::StreamExt;
use hyori_storage::{CHUNK_SIZE, MAX_PARTS, ObjectStorage, StorageError, StorageStream};
use sea_orm::ConnectionTrait;
use std::{future::Future, sync::Arc, time::Duration};
use tracing::Instrument;

pub(crate) fn storage_error(error: StorageError) -> ApiError {
    crate::observability::storage_error();
    // StorageError contains only owned operation/status/code diagnostics, never keys or requests.
    tracing::error!(category = "storage", %error, "storage operation failed");
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
        let _permit = admission::begin(&self.state, &self.context, &input).await?;
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
        let _permit = admission::existing(&self.state, &self.context, id).await?;
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
                    if !claim(tx, &upload, &token, "starting").await? {
                        return Err(ApiError::conflict().into());
                    }
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
        let _permit = admission::existing(&self.state, &self.context, &input.upload_id.0).await?;
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
                // Refuse on the small RPC before the client streams bytes. An early PUT
                // rejection can lose its envelope when a proxy cancels that request body.
                // This is only a preflight: the PUT still authorizes and claims atomically.
                if upload.lease_until.is_some_and(|until| until > Utc::now()) {
                    return Err(ApiError::upload_busy().into());
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
    ) -> Result<AcknowledgedPart, ApiError> {
        let permit = admission::existing(&self.state, &self.context, &id).await?;
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
    ) -> Result<AcknowledgedPart, ApiError> {
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
            // A retry of a part whose previous request is still unwinding (for example its
            // connection died mid-body) is told to retry, not that the part conflicts.
            if !claim(tx,&upload,&token,"uploading").await? { return Err(ApiError::upload_busy().into()); }
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
                // Contributions into someone else's space stay reserved only while parts arrive.
                tx.execute_raw(sql("UPDATE hyori_uploads SET lease_token=NULL,lease_until=NULL,
                    expires_at=CASE WHEN initiator IS DISTINCT FROM owner_id THEN LEAST(created_at+interval '7 days',GREATEST(expires_at,now()+$3::bigint*interval '1 second')) ELSE expires_at END,
                    cleanup_due=CASE WHEN initiator IS DISTINCT FROM owner_id THEN LEAST(created_at+interval '7 days',GREATEST(expires_at,now()+$3::bigint*interval '1 second')) ELSE cleanup_due END
                    WHERE id=$1 AND lease_token=$2",vec![id.into(),token.into(),CONTRIBUTION_IDLE_SECONDS.into()])).await?;
            } else if let Some(checksum) = checksum {
                let stored = tx.query_one_raw(sql("SELECT editor_sha256 FROM hyori_upload_parts WHERE upload_id=$1 AND part_number=$2",vec![id.into(),(number as i32).into()])).await?.ok_or_else(ApiError::conflict)?;
                if stored.try_get::<Option<String>>("","editor_sha256")?.as_deref() != Some(&checksum) { return Err(ApiError::invalid().into()); }
            }
            // Only useful transfer activity extends new owner reservations, not list/status polls.
            // NULL is the migration boundary: old reservations keep their original expiry.
            tx.execute_raw(sql("UPDATE hyori_uploads SET expires_at=now()+idle_seconds*interval '1 second',cleanup_due=now()+idle_seconds*interval '1 second' WHERE id=$1 AND idle_seconds IS NOT NULL",vec![current.id.into()])).await?;
            Ok(AcknowledgedPart { part_number: number, size: crate::features::auth::api::Bytes(length) })
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
        permit: Admission,
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
        let permit = admission::existing(&self.state, &self.context, &input.upload_id.0).await?;
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
                    if !claim(tx, &upload, &token, "finalizing").await? {
                        return Err(ApiError::upload_busy().into());
                    }
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
        let media = self.state.media_worker.is_some();
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
                    parent_readable: false,
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
                if media && crate::features::media::service::supported(&item) {
                    // Publication enqueues its own thumbnail; discovery is only a safety net.
                    crate::features::media::service::enqueue(tx, &item).await?;
                }
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
                // must not trap a still-authenticated initiator's reservation until expiry. The
                // destination owner may also cancel anyone's pending upload into their space.
                let upload = match policy::initiated(tx, &context, &id).await {
                    Ok((upload, _)) => upload,
                    // Only a domain refusal falls through; database errors keep their SQLSTATE
                    // for the retry owner.
                    Err(db::DomainError::Api(denied)) => {
                        let upload = Upload::get(tx, &id).await?;
                        let actor = files::resolve_actor(tx, &context).await?;
                        if actor.user_id() != Some(upload.owner_id.as_str()) {
                            return Err(denied.into());
                        }
                        if upload.state == "complete" {
                            return Err(ApiError::conflict().into());
                        }
                        upload
                    }
                    Err(error) => return Err(error),
                };
                upload.abort(tx).await?;
                Ok(Done { success: true })
            })
        })
        .await
    }
    /// Uploads initiated by this account, including reservations in shared spaces. No local
    /// browser checkpoint or continuing destination access is needed to find/cancel one's work.
    pub async fn pending(&self, input: PendingUploadsInput) -> Result<PendingUploads, ApiError> {
        db::domain(&self.state.db, |tx| {
            let (context, input) = (self.context.clone(), input.clone());
            Box::pin(async move {
                let actor = files::resolve_actor(tx, &context).await?;
                let user = actor.require_user()?;
                let cursor = input.cursor.0.map(|id| id.0).unwrap_or_default();
                let rows = tx.query_all_raw(sql(
                    "SELECT id,name,size,expires_at FROM hyori_uploads WHERE uploader_id=$1 AND reservation_held AND id>$2 ORDER BY id LIMIT $3",
                    vec![user.into(),cursor.into(),(i64::from(input.limit)+1).into()],
                )).await?;
                let has_next = rows.len() > input.limit as usize;
                let items = rows.into_iter().take(input.limit as usize).map(|row| Ok(PendingUpload {
                    upload_id: crate::features::auth::api::Id(row.try_get("", "id")?),
                    name: row.try_get("", "name")?,
                    size: crate::features::auth::api::Bytes(row.try_get::<i64>("", "size")? as u64),
                    expires_at: row.try_get::<chrono::DateTime<Utc>>("", "expires_at")?.to_rfc3339(),
                })).collect::<db::DomainResult<Vec<_>>>()?;
                let cursor = crate::wire::Nullable(if has_next { items.last().map(|item| item.upload_id.clone()) } else { None });
                Ok(PendingUploads { items, cursor })
            })
        }).await
    }
    /// Other people's pending uploads into the signed-in owner's space, oldest first, so the
    /// owner can see and cancel reservations held against their quota.
    pub async fn incoming(&self) -> Result<IncomingUploads, ApiError> {
        db::domain(&self.state.db, |tx| {
            let context = self.context.clone();
            Box::pin(async move {
                let actor = files::resolve_actor(tx, &context).await?;
                let owner = actor.require_user()?;
                let rows = tx.query_all_raw(sql(
                    "SELECT id,name,size,expires_at,uploader_id IS NULL AS anonymous FROM hyori_uploads
                     WHERE owner_id=$1 AND reservation_held AND initiator IS DISTINCT FROM owner_id
                     ORDER BY created_at,id LIMIT 128",
                    vec![owner.into()],
                )).await?;
                let items = rows.iter().map(|row| Ok(IncomingUpload {
                    upload_id: crate::features::auth::api::Id(row.try_get("", "id")?),
                    name: row.try_get("", "name")?,
                    size: crate::features::auth::api::Bytes(row.try_get::<i64>("", "size")? as u64),
                    expires_at: row.try_get::<chrono::DateTime<Utc>>("", "expires_at")?.to_rfc3339(),
                    anonymous: row.try_get("", "anonymous")?,
                })).collect::<db::DomainResult<Vec<_>>>()?;
                Ok(IncomingUploads { items })
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
    let owner = tx
        .query_one_raw(sql(
            "SELECT pending_uploads,quota_bytes-used_bytes-reserved_bytes AS free FROM hyori_users WHERE id=$1",
            vec![destination.owner_id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::unavailable)?;
    if owner.try_get::<i32>("", "pending_uploads")? >= 128 {
        return Err(
            ApiError::new(ErrorCode::UploadLimit, "Unfinished upload limit reached").into(),
        );
    }
    let initiator = match actor.user_id() {
        Some(user) => user.to_owned(),
        None => {
            let mut shares = actor.public_shares().to_vec();
            shares.sort_unstable();
            format!("shares:{}", shares.join(","))
        }
    };
    let contribution = initiator != destination.owner_id;
    if contribution {
        // Someone else's space: bound how much of it one contributor can hold at once.
        let held = tx
            .query_one_raw(sql(
                "SELECT count(*)::bigint AS uploads,coalesce(sum(size),0)::bigint AS bytes FROM hyori_uploads WHERE owner_id=$1 AND initiator=$2 AND reservation_held",
                vec![destination.owner_id.clone().into(), initiator.clone().into()],
            ))
            .await?
            .ok_or_else(ApiError::unavailable)?;
        let (uploads, bytes) = (
            held.try_get::<i64>("", "uploads")?,
            held.try_get::<i64>("", "bytes")?,
        );
        if !contribution_admitted(
            uploads,
            bytes,
            owner.try_get("", "free")?,
            input.size.0 as i64,
        ) {
            return Err(ApiError::new(
                ErrorCode::QuotaExceeded,
                "Too many pending uploads into this space",
            )
            .into());
        }
    }
    // Inventory and full reservation commit before any storage effect. A contribution expires
    // unless parts keep arriving; new owner uploads expire after 24 hours without a part ack.
    tx.execute_raw(sql(
        "INSERT INTO hyori_uploads(id,owner_id,uploader_id,grant_digests,parent_id,name,size,mime_type,object_key,replace_id,replace_revision,state,initiator,expires_at,idle_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'starting',$12,now()+$13::bigint*interval '1 second',$14)",
        vec![id.into(), destination.owner_id.clone().into(), actor.user_id().into(),
            serde_json::json!(context.grants.iter().map(|t| digest(t)).collect::<Vec<_>>()).into(),
            parent.into(), input.name.0.clone().into(), (input.size.0 as i64).into(), input.mime_type.clone().into(),
            format!("owners/{}/{id}",destination.owner_id).into(), replacement.into(), previous.map(|p| p.revision).into(),
            initiator.into(), if contribution { CONTRIBUTION_IDLE_SECONDS } else { OWN_UPLOAD_SECONDS }.into(),
            if contribution { None } else { Some(OWN_UPLOAD_SECONDS) }.into()],
    )).await?;
    tx.execute_raw(sql(
        "UPDATE hyori_users SET reserved_bytes=reserved_bytes+$2 WHERE id=$1",
        vec![destination.owner_id.into(), (input.size.0 as i64).into()],
    ))
    .await?;
    Upload::get(tx, id).await
}
/// A contribution reservation must arrive within, and is extended by each part to, this window.
pub(crate) const CONTRIBUTION_IDLE_SECONDS: i64 = 60 * 60;
const OWN_UPLOAD_SECONDS: i64 = 24 * 60 * 60;
/// Pending uploads one contributor may hold in another account's space.
pub(crate) const CONTRIBUTION_PENDING_LIMIT: i64 = 16;
/// A contributor may reserve at most half of the space still available to them (the owner's
/// free bytes plus what they already hold), so one contributor can't exhaust anyone's quota.
fn contribution_admitted(uploads: i64, held: i64, free: i64, size: i64) -> bool {
    uploads < CONTRIBUTION_PENDING_LIMIT && (held + size).saturating_mul(2) <= free + held
}
fn terminal(upload: &Upload) -> Result<FileEntry, ApiError> {
    serde_json::from_value(upload.result.clone().ok_or_else(ApiError::unavailable)?)
        .map_err(|_| ApiError::unavailable())
}
/// False when another operation holds the upload's lease.
async fn claim(
    tx: &sea_orm::DatabaseTransaction,
    upload: &Upload,
    token: &str,
    state: &str,
) -> db::DomainResult<bool> {
    let changed = tx.execute_raw(sql("UPDATE hyori_uploads SET state=$3,lease_token=$2,lease_until=now()+interval '3 minutes' WHERE id=$1 AND (lease_until IS NULL OR lease_until<=now())",vec![upload.id.clone().into(),token.into(),state.into()])).await?;
    Ok(changed.rows_affected() == 1)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_contributor_may_hold_at_most_half_of_the_space_left_to_them() {
        assert!(contribution_admitted(0, 0, 1000, 500));
        assert!(!contribution_admitted(0, 0, 1000, 501));
        // Already holding 400 of what was 1,400 free: at most 700 in total.
        assert!(contribution_admitted(1, 400, 1000, 300));
        assert!(!contribution_admitted(1, 400, 1000, 301));
        assert!(contribution_admitted(15, 0, 0, 0));
        assert!(!contribution_admitted(
            CONTRIBUTION_PENDING_LIMIT,
            0,
            1000,
            0
        ));
    }
}

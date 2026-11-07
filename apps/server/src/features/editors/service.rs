use crate::{
    AppState,
    auth::{digest, random_token},
    db::{self, sql},
    error::ApiError,
    features::{
        auth::api::{Bytes, Id, Name},
        editors::{api::*, formats, policy},
        files::{
            ContentDescriptor,
            api::{Download, FileKind, ItemInput},
            policy::{self as files, Action},
        },
        uploads::{
            api::{BeginUpload, UploadInput, UploadStatus},
            db::Upload,
            service::{self as uploads, UploadsService},
        },
    },
    rpc::RequestContext,
    wire::Nullable,
};
use sea_orm::ConnectionTrait;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(crate) struct EditorsService {
    state: Arc<AppState>,
    context: RequestContext,
}
impl EditorsService {
    pub fn new(state: Arc<AppState>, context: RequestContext) -> Self {
        Self { state, context }
    }
    pub async fn close(
        &self,
        input: EditorCloseInput,
    ) -> Result<crate::features::auth::api::Done, ApiError> {
        // Closing aborts unfinished saves, which release reservations on the owner's row. Queue
        // with that owner's other upload transactions rather than failing serialization.
        let owner = self.session_owner(&input.session_id.0).await?;
        let _queued = self.state.owner_locks.lock(owner.as_deref()).await;
        db::domain(&self.state.db, |tx| {
            let (context, id) = (self.context.clone(), input.session_id.0.clone());
            Box::pin(async move {
                super::cleanup::close(tx, &context, &id).await?;
                Ok(crate::features::auth::api::Done { success: true })
            })
        })
        .await
    }
    pub async fn available(&self) -> Result<EditorAvailability, ApiError> {
        if self.state.storage.is_none() {
            return Ok(EditorAvailability { apps: vec![] });
        }
        let rows = self
            .state
            .db
            .query_all_raw(sql(
                "SELECT app,version FROM hyori_editor_assets WHERE enabled ORDER BY app LIMIT 4",
                vec![],
            ))
            .await?;
        let enabled = rows
            .into_iter()
            .map(|row| {
                Ok::<_, sea_orm::DbErr>((
                    row.try_get::<String>("", "app")?,
                    row.try_get::<String>("", "version")?,
                ))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut apps = Vec::new();
        for app in formats::APPS {
            let Ok(capability) = self.state.editor_assets.capability(&app) else {
                continue;
            };
            if enabled.iter().any(|(name, version)| {
                name == formats::app_name(&app) && version == &capability.version
            }) {
                apps.push(EditorAvailableApp {
                    app: app.clone(),
                    version: capability.version.clone(),
                    input_extensions: formats::input_extensions(&app)
                        .iter()
                        .map(|extension| (*extension).to_owned())
                        .collect(),
                });
            }
        }
        Ok(EditorAvailability { apps })
    }
    pub async fn open(&self, input: ItemInput) -> Result<EditorDocument, ApiError> {
        self.state
            .storage
            .as_ref()
            .ok_or_else(ApiError::unavailable)?;
        let id = random_token();
        db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context,input,id) = (self.context.clone(),input.clone(),id.clone());
            Box::pin(async move {
                let actor = files::resolve_actor(tx,&context).await?;
                let item = files::authorize(tx,&actor,&input.id.0,Action::Read,false).await?;
                let app = formats::app(&item.name)?;
                policy::enabled(tx,&assets,&app).await?;
                let capability = assets.capability(&app)?;
                formats::validate_transport_name(&app,&item.name)?;
                if item.kind != FileKind::File || item.size <= 0 || item.size as u64 > formats::max_bytes(&app) || item.object_key.is_none() { return Err(ApiError::invalid().into()); }
                let mut grants: Vec<_> = context.grants.iter().map(|token| digest(token)).collect();
                grants.sort(); grants.dedup();
                let principal = actor.user_id().map(str::to_owned).unwrap_or_else(|| digest(&grants.join(":")));
                // Owner lock also serializes admission against purge/reservations.
                tx.query_one_raw(sql("SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR NO KEY UPDATE",vec![item.owner_id.clone().into()])).await?.ok_or_else(ApiError::denied)?;
                super::cleanup::admit(tx,&item.owner_id,&principal,actor.user_id()).await?;
                tx.execute_raw(sql("INSERT INTO hyori_editor_sessions(id,file_id,owner_id,initiator_id,grant_digests,principal,app,version,revision,name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",vec![id.clone().into(),item.id.clone().into(),item.owner_id.clone().into(),actor.user_id().into(),serde_json::json!(grants).into(),principal.into(),formats::app_name(&app).into(),capability.version.clone().into(),item.revision.into(),item.name.clone().into()])).await?;
                Ok(EditorDocument {
                    session_id: Id(id), version: capability.version.clone(), asset_url: capability.asset_url.clone(), name: Name(item.name.clone()), revision: item.revision.to_string(),
                    bridge: match (capability.bridge.as_str(), capability.protocol) {
                        ("upstream-host-parent", None) => EditorBridge::Upstream,
                        ("hyori-correlated-host-v1", Some(1)) => EditorBridge::CorrelatedV1,
                        ("hyori-correlated-host-v2", Some(2)) => EditorBridge::CorrelatedV2,
                        _ => return Err(ApiError::unavailable().into()),
                    },
                    protocol: Nullable(capability.protocol.map(EditorProtocol)),
                    writable: files::access(&item,&actor).can_edit, max_bytes: Bytes(formats::max_bytes(&app)), replacement_name: Nullable(formats::replacement(&item.name).map(Name)), output_formats: formats::outputs(&app), app,
                })
            })
        }).await
    }
    pub async fn content(&self, input: EditorDownloadInput) -> Result<ContentDescriptor, ApiError> {
        db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, input) = (self.context.clone(), input.clone());
            Box::pin(async move {
                let (session, _, item) =
                    policy::session(tx, &assets, &context, &input.session_id.0, Action::Read)
                        .await?;
                let expected: i64 = input
                    .expected_revision
                    .parse()
                    .map_err(|_| ApiError::invalid())?;
                policy::revision(&session, &item, expected)?;
                Ok(ContentDescriptor {
                    object_key: item.object_key.ok_or_else(ApiError::not_found)?,
                    name: item.name,
                    size: item.size,
                    mime_type: item.mime_type,
                    revision: item.revision,
                })
            })
        })
        .await
    }
    pub async fn download(&self, input: EditorDownloadInput) -> Result<Download, ApiError> {
        let content = self.content(input.clone()).await?;
        Ok(Download {
            url: format!(
                "/api/storage/editors/{}?revision={}",
                input.session_id.0, content.revision
            ),
            name: Name(content.name),
            size: Bytes(content.size as u64),
            mime_type: content.mime_type,
        })
    }
    /// A hint for in-process queueing only; the transaction still authorizes the session.
    async fn session_owner(&self, session: &str) -> Result<Option<String>, ApiError> {
        Ok(self
            .state
            .db
            .query_one_raw(sql(
                "SELECT owner_id FROM hyori_editor_sessions WHERE id=$1",
                vec![session.into()],
            ))
            .await?
            .map(|row| row.try_get::<String>("", "owner_id"))
            .transpose()?)
    }
    pub async fn prepare_save(&self, input: EditorPrepareSave) -> Result<UploadStatus, ApiError> {
        self.state
            .storage
            .as_ref()
            .ok_or_else(ApiError::unavailable)?;
        let expected: i64 = input
            .expected_revision
            .parse()
            .map_err(|_| ApiError::invalid())?;
        if (input.save_mode == Some(EditorSaveMode::Automatic)
            && input.intent != EditorIntent::Replace)
            || expected < 0
            || expected.to_string() != input.expected_revision
            || input.size.0 == 0
            || input.sha256.len() != 64
            || !input
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ApiError::invalid());
        }
        if files::normalize_name(&input.name.0)? != input.name.0 {
            return Err(ApiError::invalid());
        }
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(&input).map_err(|_| ApiError::invalid())?,
        ));
        let upload_id = random_token();
        // Reserving quota touches the owner's row; queue with their other upload transactions.
        let owner = self.session_owner(&input.session_id.0).await?;
        let _queued = self.state.owner_locks.lock(owner.as_deref()).await;
        let id = db::domain(&self.state.db,|tx| {
            let assets = self.state.editor_assets.clone();
            let (context,input,fingerprint,upload_id) = (self.context.clone(),input.clone(),fingerprint.clone(),upload_id.clone());
            Box::pin(async move {
                let action = if input.intent == EditorIntent::Replace { Action::Edit } else { Action::Read };
                let (session,_,item) = policy::session(tx,&assets,&context,&input.session_id.0,action).await?;
                if let Some(save) = tx.query_one_raw(sql("SELECT fingerprint,upload_id FROM hyori_editor_saves WHERE session_id=$1 AND save_id=$2",vec![session.id.clone().into(),input.save_id.clone().into()])).await? {
                    if save.try_get::<String>("","fingerprint")? != fingerprint { return Err(ApiError::invalid().into()); }
                    let id = save.try_get::<String>("","upload_id")?;
                    crate::features::uploads::policy::checked(tx,&assets,&context,&id).await?;
                    return Ok(id);
                }
                super::retention::admit(tx,&session.id,&input.save_id).await?;
                policy::revision(&session,&item,expected)?;
                formats::validate_output(&session.app,&input.name.0,&input.intent)?;
                if input.size.0 > formats::max_bytes(&session.app).min(formats::max_bytes(&formats::app(&input.name.0)?)) { return Err(ApiError::invalid().into()); }
                let (parent_id,replace_id) = if input.intent == EditorIntent::Replace {
                    if input.destination.is_some() || formats::replacement(&session.name).as_deref() != Some(&input.name.0) { return Err(ApiError::invalid().into()); }
                    (Nullable(item.parent_id.map(Id)),Some(Id(item.id)))
                } else {
                    (input.destination.as_ref().ok_or_else(ApiError::invalid)?.parent_id.clone(),None)
                };
                let begin = BeginUpload { parent_id,name: input.name.clone(),size: input.size.clone(),mime_type: formats::mime(&input.name.0)?.into(),replace_id };
                let upload = uploads::reserve(tx,&context,&begin,&upload_id).await?;
                tx.execute_raw(sql("UPDATE hyori_uploads SET editor_bound=true WHERE id=$1",vec![upload_id.clone().into()])).await?;
                tx.execute_raw(sql("INSERT INTO hyori_editor_saves(session_id,save_id,upload_id,fingerprint,sha256,expected_revision,intent,destination_owner_id,save_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",vec![session.id.into(),input.save_id.into(),upload_id.clone().into(),fingerprint.into(),input.sha256.into(),expected.into(),match input.intent { EditorIntent::Replace => "replace",EditorIntent::SaveAs => "save-as",EditorIntent::Export => "export" }.into(),upload.owner_id.into(),match input.save_mode { Some(EditorSaveMode::Automatic) => "automatic", _ => "manual" }.into()])).await?;
                Ok(upload_id)
            })
        }).await?;
        UploadsService::new(self.state.clone(), self.context.clone())
            .start_reserved(&id)
            .await
    }
    pub async fn complete_save(&self, input: EditorSaveInput) -> Result<EditorSaved, ApiError> {
        let id = db::domain(&self.state.db,|tx| {
            let assets = self.state.editor_assets.clone();
            let (context,input)=(self.context.clone(),input.clone());
            Box::pin(async move {
                policy::session(tx,&assets,&context,&input.session_id.0,Action::Read).await?;
                let Some(save) = tx.query_one_raw(sql("SELECT upload_id FROM hyori_editor_saves WHERE session_id=$1 AND save_id=$2",vec![input.session_id.0.clone().into(),input.save_id.clone().into()])).await? else {
                    return Err(super::retention::missing_save(tx,&input.session_id.0,&input.save_id).await?.into());
                };
                Ok(save.try_get::<String>("","upload_id")?)
            })
        }).await?;
        UploadsService::new(self.state.clone(), self.context.clone())
            .complete(UploadInput {
                upload_id: Id(id.clone()),
            })
            .await?;
        db::domain(&self.state.db, |tx| {
            let assets = self.state.editor_assets.clone();
            let (context, id) = (self.context.clone(), id.clone());
            Box::pin(async move {
                let (upload, _) =
                    crate::features::uploads::policy::checked(tx, &assets, &context, &id).await?;
                let row = tx
                    .query_one_raw(sql(
                        "SELECT result FROM hyori_editor_saves WHERE upload_id=$1",
                        vec![id.into()],
                    ))
                    .await?
                    .ok_or_else(ApiError::not_found)?;
                let mut result: EditorSaved = serde_json::from_value(row.try_get("", "result")?)
                    .map_err(|_| ApiError::unavailable())?;
                // Preserve immutable saved revision/result, but refresh current permission flags.
                if let Some(file) = upload.result {
                    result.file.access = serde_json::from_value(file["access"].clone())
                        .map_err(|_| ApiError::unavailable())?;
                }
                Ok(result)
            })
        })
        .await
    }
}

pub(crate) async fn validate_upload(state: &AppState, upload: &Upload) -> Result<(), ApiError> {
    if !upload.editor_bound {
        return Ok(());
    }
    let row = state
        .db
        .query_one_raw(sql(
            "SELECT sha256 FROM hyori_editor_saves WHERE upload_id=$1",
            vec![upload.id.clone().into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?;
    let hash: String = row.try_get("", "sha256")?;
    formats::inspect(
        state.storage.as_ref().ok_or_else(ApiError::unavailable)?,
        &upload.object_key,
        &upload.name,
        upload.size as u64,
        Some(&hash),
    )
    .await
}

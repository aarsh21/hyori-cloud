use crate::{
    AppState,
    db::sql,
    error::ApiError,
    features::{
        files::{
            ContentDescriptor,
            policy::{self, Action},
            service::FilesService,
        },
        uploads::http::stream_content,
    },
    rpc::validate_origin,
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::Request,
    response::Response,
};
use sea_orm::ConnectionTrait;
use std::sync::Arc;

pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    Path((id, artifact)): Path<(String, String)>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    validate_origin(request.headers(), &state.config.origin)?;
    let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
    let descriptor=FilesService::new(&state,state.request_context(request.headers())).run(move|tx,actor|{let(id,artifact)=(id.clone(),artifact.clone());Box::pin(async move{
        let item=policy::authorize(tx,&actor,&id,Action::Read,false).await?;
        let row=tx.query_one_raw(sql("SELECT a.object_key,a.size FROM hyori_media_jobs j JOIN hyori_media_artifacts a ON a.id=j.artifact_id AND a.recipe=j.recipe
            WHERE j.source_key=$1 AND j.owner_id=$2 AND j.recipe IN ($3,$4) AND j.state='ready' AND a.state='ready' AND a.id=$5",
            vec![item.object_key.into(),item.owner_id.into(),hyori_media_worker::RECIPE.into(),hyori_media_worker::DISPLAY_RECIPE.into(),artifact.into()])).await?.ok_or_else(ApiError::not_found)?;
        let object_key: String = row.try_get("","object_key")?;
        let (name,mime) = if object_key.ends_with("_webp") { ("thumbnail.webp","image/webp") } else { ("thumbnail.png","image/png") };
        Ok(ContentDescriptor{object_key,name:name.into(),size:row.try_get("","size")?,mime_type:mime.into(),revision:item.revision})
    })}).await?;
    let mime = if descriptor.mime_type == "image/webp" {
        "image/webp"
    } else {
        "image/png"
    };
    stream_content(
        storage,
        descriptor,
        request.headers(),
        permit,
        mime,
        "inline",
    )
    .await
}

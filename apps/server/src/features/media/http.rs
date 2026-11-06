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
    rpc::{RequestContext, validate_origin},
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
    let descriptor=FilesService::new(&state,RequestContext::from_headers(request.headers())).run(move|tx,actor|{let(id,artifact)=(id.clone(),artifact.clone());Box::pin(async move{
        let item=policy::authorize(tx,&actor,&id,Action::Read,false).await?;
        let row=tx.query_one_raw(sql("SELECT a.object_key,a.size FROM hyori_media_jobs j JOIN hyori_media_artifacts a ON a.id=j.artifact_id
            WHERE j.source_key=$1 AND j.owner_id=$2 AND j.recipe=$3 AND j.state='ready' AND a.state='ready' AND a.id=$4",vec![item.object_key.into(),item.owner_id.into(),hyori_media_worker::RECIPE.into(),artifact.into()])).await?.ok_or_else(ApiError::not_found)?;
        Ok(ContentDescriptor{object_key:row.try_get("","object_key")?,name:"thumbnail.png".into(),size:row.try_get("","size")?,mime_type:"image/png".into(),revision:item.revision})
    })}).await?;
    stream_content(
        storage,
        descriptor,
        request.headers(),
        permit,
        "image/png",
        "inline",
    )
    .await
}

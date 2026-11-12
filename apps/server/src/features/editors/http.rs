use crate::{
    AppState,
    error::ApiError,
    features::{
        auth::api::Id,
        editors::{api::EditorDownloadInput, formats, service::EditorsService},
        uploads::http::stream_content,
    },
    rpc::validate_origin,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    response::Response,
};
use std::sync::Arc;

#[derive(serde::Deserialize)]
pub(crate) struct RevisionQuery {
    revision: String,
}

pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<RevisionQuery>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    validate_origin(request.headers(), &state.config.origin)?;
    let context = state.request_context(request.headers());
    let service = EditorsService::new(state.clone(), context);
    let input = EditorDownloadInput {
        session_id: Id(id),
        expected_revision: query.revision,
    };
    let descriptor = service.content(input.clone()).await?;
    let storage = state.storage.as_ref().ok_or_else(ApiError::unavailable)?;
    formats::inspect(
        storage,
        &descriptor.object_key,
        &descriptor.name,
        descriptor.size as u64,
        None,
    )
    .await?;
    // Inspection may take time: reauthorize and compare again before exposing the immutable bytes.
    let current = service.content(input).await?;
    if current.object_key != descriptor.object_key || current.revision != descriptor.revision {
        return Err(ApiError::conflict());
    }
    stream_content(
        storage,
        descriptor,
        request.headers(),
        permit,
        "application/octet-stream",
        "attachment",
    )
    .await
}

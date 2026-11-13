use crate::{
    AppState,
    error::ApiError,
    features::{notes::service::NotesService, uploads::http::stream_bytes},
    rpc::validate_origin,
};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub(crate) struct ExportQuery {
    fence: String,
}

pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    validate_origin(request.headers(), &state.config.origin)?;
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    if query.fence.len() > 128 {
        return Err(ApiError::invalid());
    }
    let bytes = NotesService::new(&state, state.request_context(request.headers()))
        .download(id, query.fence)
        .await?;
    let length = bytes.len().to_string();
    Ok((
        [
            ("content-type", "application/json"),
            ("content-length", length.as_str()),
            (
                "content-disposition",
                "attachment; filename=note.hyori-note.json",
            ),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
            ("content-security-policy", "sandbox; default-src 'none'"),
        ],
        stream_bytes(bytes, permit),
    )
        .into_response())
}

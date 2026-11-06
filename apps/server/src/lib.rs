//! Rust application composition. Feature contracts and domain authorization stay server-owned.
#![forbid(unsafe_code)]

pub mod auth;
pub mod config;
pub mod db;
pub mod editor_assets;
pub mod error;
pub mod features;
pub mod maintenance;
mod media_worker;
pub mod rpc;
pub mod wire;

use crate::{auth::AuthAdapter, config::Config, error::ApiError, rpc::RpcRegistry};
use axum::{
    Router, middleware,
    routing::{get, post},
};
use sea_orm::DatabaseConnection;
use std::sync::Arc;

pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Arc<Config>,
    pub auth: AuthAdapter,
    pub rpc: RpcRegistry,
    pub storage: Option<hyori_storage::ObjectStorage>,
    pub(crate) media_worker: Option<media_worker::WorkerClient>,
    pub(crate) editor_assets: editor_assets::EditorAssets,
    pub(crate) transfers: Arc<tokio::sync::Semaphore>,
    pub(crate) requests: tokio::sync::Semaphore,
    pub(crate) upload_cleanup: tokio::sync::Notify,
    pub(crate) owner_locks: db::OwnerLocks,
}
impl AppState {
    /// Call after HTTP admission ends, before closing storage/database resources.
    pub async fn drain_transfers(&self) -> Result<(), ApiError> {
        let _drained = self
            .transfers
            .acquire_many(16)
            .await
            .map_err(|_| ApiError::unavailable())?;
        self.transfers.close();
        Ok(())
    }
    pub async fn connect(config: Config) -> Result<Arc<Self>, ApiError> {
        config.validate().map_err(|_| ApiError::unavailable())?;
        let editor_assets = editor_assets::EditorAssets::load(&config).await?;
        let mut rpc = RpcRegistry::new().map_err(contract_failure)?;
        features::auth::api::bind(&mut rpc).map_err(contract_failure)?;
        features::admin::api::bind(&mut rpc).map_err(contract_failure)?;
        features::files::api::bind(&mut rpc).map_err(contract_failure)?;
        features::shares::api::bind(&mut rpc).map_err(contract_failure)?;
        features::uploads::api::bind(&mut rpc).map_err(contract_failure)?;
        features::photos::api::bind(&mut rpc).map_err(contract_failure)?;
        features::media::api::bind(&mut rpc).map_err(contract_failure)?;
        features::editors::api::bind(&mut rpc).map_err(contract_failure)?;
        let media_worker = config
            .media_worker_socket
            .as_deref()
            .map(media_worker::WorkerClient::new)
            .transpose()?;
        let storage = config
            .storage
            .clone()
            .map(hyori_storage::ObjectStorage::new)
            .transpose()
            .map_err(|_| ApiError::unavailable())?;
        let db = db::connect(&config).await?;
        db::migrate(&db).await?;
        editor_assets.activate(&db).await?;
        if let Some(storage) = &storage {
            storage
                .ensure_bucket()
                .await
                .map_err(|_| ApiError::unavailable())?;
        }
        let config = Arc::new(config);
        Ok(Arc::new(Self {
            db,
            auth: AuthAdapter::new(config.clone()),
            config,
            rpc,
            storage,
            media_worker,
            editor_assets,
            transfers: Arc::new(tokio::sync::Semaphore::new(16)),
            requests: tokio::sync::Semaphore::new(128),
            upload_cleanup: tokio::sync::Notify::new(),
            owner_locks: db::OwnerLocks::new(),
        }))
    }
}
fn contract_failure(error: wire::ContractError) -> ApiError {
    tracing::error!(%error, "application contract initialization failed");
    ApiError::unavailable()
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/rpc", post(rpc::handle))
        .route(
            "/api/storage/uploads/{id}/{number}",
            axum::routing::put(features::uploads::http::put),
        )
        .route("/api/storage/files/{id}", get(features::uploads::http::get))
        .route(
            "/api/storage/previews/{id}",
            get(features::files::preview::get),
        )
        .route(
            "/api/storage/derivatives/{id}/{artifact}",
            get(features::media::http::get),
        )
        .route(
            "/api/storage/editors/{id}",
            get(features::editors::http::get),
        )
        .route("/health/live", get(rpc::live))
        .route("/health/ready", get(rpc::ready))
        .fallback(rpc::fallback)
        .method_not_allowed_fallback(rpc::fallback)
        .layer(middleware::from_fn(rpc::no_store))
        .with_state(state)
}

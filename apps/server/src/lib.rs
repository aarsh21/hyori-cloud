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
    /// Download-like bodies (originals, previews, thumbnails, editor bytes). A permit lives in the
    /// task that drives one body and is dropped when that body finishes, fails or stalls.
    pub(crate) transfers: Arc<tokio::sync::Semaphore>,
    /// Upload begin/part/complete operations, admitted independently of downloads.
    pub(crate) uploads: Arc<tokio::sync::Semaphore>,
    pub(crate) upload_principals: features::uploads::http::PrincipalLimiter,
    pub(crate) download_principals: features::uploads::http::PrincipalLimiter,
    pub(crate) requests: tokio::sync::Semaphore,
    pub(crate) upload_cleanup: tokio::sync::Notify,
    /// Wakes account purge maintenance after a deletion commits.
    pub(crate) account_purge: tokio::sync::Notify,
    /// Resume point of the incremental thumbnail discovery sweep (an item ID; empty restarts).
    pub(crate) media_discovery: tokio::sync::Mutex<String>,
    pub(crate) owner_locks: db::OwnerLocks,
}
impl AppState {
    /// Call after HTTP admission ends, before closing storage/database resources.
    pub async fn drain_transfers(&self) -> Result<(), ApiError> {
        let (downloads, uploads) = tokio::join!(
            self.transfers
                .acquire_many(config::DOWNLOAD_CONCURRENCY as u32),
            self.uploads.acquire_many(config::UPLOAD_CONCURRENCY as u32)
        );
        let _drained = (
            downloads.map_err(|_| ApiError::unavailable())?,
            uploads.map_err(|_| ApiError::unavailable())?,
        );
        self.transfers.close();
        self.uploads.close();
        Ok(())
    }
    pub async fn connect(config: Config) -> Result<Arc<Self>, ApiError> {
        config
            .validate()
            .map_err(|error| startup_failure("configuration", error))?;
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
            .map_err(|error| startup_failure("storage client", error))?;
        let db = db::connect(&config).await?;
        db::migrate(&db).await?;
        let initialized = sea_orm::ConnectionTrait::query_one_raw(
            &db,
            db::sql(
                "SELECT initialized FROM hyori_bootstrap WHERE singleton=true",
                vec![],
            ),
        )
        .await?
        .ok_or_else(ApiError::unavailable)?
        .try_get::<bool>("", "initialized")?;
        if !initialized {
            config::require_strong_setup_token(&config.setup_token)
                .map_err(|error| startup_failure("setup token", error))?;
        }
        editor_assets.activate(&db).await?;
        if let Some(storage) = &storage {
            storage
                .ensure_bucket()
                .await
                .map_err(|error| startup_failure("storage bucket", error))?;
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
            transfers: Arc::new(tokio::sync::Semaphore::new(config::DOWNLOAD_CONCURRENCY)),
            uploads: Arc::new(tokio::sync::Semaphore::new(config::UPLOAD_CONCURRENCY)),
            upload_principals: features::uploads::http::PrincipalLimiter::default(),
            download_principals: features::uploads::http::PrincipalLimiter::default(),
            requests: tokio::sync::Semaphore::new(config::RPC_CONCURRENCY),
            upload_cleanup: tokio::sync::Notify::new(),
            account_purge: tokio::sync::Notify::new(),
            media_discovery: tokio::sync::Mutex::new(String::new()),
            owner_locks: db::OwnerLocks::new(),
        }))
    }
}
/// Configuration and storage errors carry only static text, operation names, HTTP status and S3
/// error codes, never credentials, so the operator can tell a rejected key from an outage.
fn startup_failure(stage: &'static str, error: impl std::fmt::Display) -> ApiError {
    tracing::error!(stage, %error, "startup failed");
    ApiError::unavailable()
}
fn contract_failure(error: wire::ContractError) -> ApiError {
    tracing::error!(%error, "application contract initialization failed");
    ApiError::unavailable()
}

/// Serve with `into_make_service_with_connect_info::<SocketAddr>()` so per-client limits see the
/// peer address; without it, anonymous callers share one budget.
pub fn router(state: Arc<AppState>) -> Router {
    // Every download-like route shares one per-principal concurrency budget.
    let downloads = Router::new()
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
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            features::uploads::http::admit_principal,
        ));
    Router::new()
        .route("/api/rpc", post(rpc::handle))
        .route(
            "/api/storage/uploads/{id}/{number}",
            axum::routing::put(features::uploads::http::put),
        )
        .merge(downloads)
        .route("/health/live", get(rpc::live))
        .route("/health/ready", get(rpc::ready))
        .fallback(rpc::fallback)
        .method_not_allowed_fallback(rpc::fallback)
        .layer(middleware::from_fn(rpc::no_store))
        .with_state(state)
}

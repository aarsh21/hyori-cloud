use crate::{
    config::{Config, DATABASE_TIMEOUT},
    error::ApiError,
};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend, Statement,
    TransactionTrait,
};
use sha2::{Digest, Sha256};

/// Every upload reservation and publication updates its owner's `hyori_users` row, so under
/// SERIALIZABLE two that overlap always cost one of them a retry, and a busy batch can exhaust
/// the budget. Queueing them here first leaves retries for contention this process can't see.
/// Striped, so different owners rarely wait on each other; the stripe is only a hint.
pub(crate) struct OwnerLocks([tokio::sync::Mutex<()>; 64]);
impl OwnerLocks {
    pub(crate) fn new() -> Self {
        Self(std::array::from_fn(|_| tokio::sync::Mutex::new(())))
    }
    pub(crate) async fn lock(
        &self,
        owner: Option<&str>,
    ) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::hash::DefaultHasher::new();
        owner?.hash(&mut hasher);
        Some(self.0[(hasher.finish() % 64) as usize].lock().await)
    }
}
pub fn sql(statement: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, statement, values)
}
pub async fn connect(config: &Config) -> Result<DatabaseConnection, ApiError> {
    let mut options = sea_orm::ConnectOptions::new(config.database_url.clone());
    options
        .max_connections(config.database_max_connections)
        .min_connections(1)
        .connect_timeout(DATABASE_TIMEOUT)
        .acquire_timeout(DATABASE_TIMEOUT)
        .sqlx_logging(false);
    Database::connect(options).await.map_err(Into::into)
}
pub async fn begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, ApiError> {
    let tx = db.begin().await?;
    tx.execute_unprepared("SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '30s'").await?;
    Ok(tx)
}
/// Preserve SQLSTATE until the transaction owner decides whether to retry.
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Database(#[from] sea_orm::DbErr),
}
pub type DomainResult<T> = Result<T, DomainError>;
pub type DomainFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = DomainResult<T>> + Send + 'a>>;

fn retry_sqlstate(error: &sea_orm::DbErr) -> Option<&'static str> {
    match crate::error::database_sqlstate(error).as_deref() {
        Some("40001") => Some("40001"),
        Some("40P01") => Some("40P01"),
        _ => None,
    }
}

/// DB-only callbacks: no storage, network, KDF, or cookie publication inside retries.
/// One snapshot covers identity, grants, hierarchy, and projected private metadata.
pub async fn domain<T, F>(db: &DatabaseConnection, operation: F) -> Result<T, ApiError>
where
    T: Send,
    F: for<'a> Fn(&'a DatabaseTransaction) -> DomainFuture<'a, T>,
{
    for attempt in 0..4 {
        let tx = db
            .begin_with_config(Some(sea_orm::IsolationLevel::Serializable), None)
            .await?;
        tx.execute_unprepared("SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '30s'").await?;
        let result = match operation(&tx).await {
            Ok(value) => tx.commit().await.map(|()| value).map_err(DomainError::from),
            Err(error) => {
                tx.rollback().await?;
                Err(error)
            }
        };
        match result {
            Ok(value) => return Ok(value),
            Err(DomainError::Database(error)) => {
                let Some(sqlstate) = retry_sqlstate(&error) else {
                    return Err(error.into());
                };
                if attempt == 3 {
                    // A bounded retry budget is infrastructure contention, not a domain conflict.
                    tracing::warn!(sqlstate, attempts = 4, "transaction retry budget exhausted");
                    return Err(ApiError::unavailable());
                }
                tracing::debug!(
                    sqlstate,
                    attempt = attempt + 1,
                    "retrying database transaction"
                );
                // Decorrelate competing snapshots without extending the four-attempt budget.
                let base_ms = 10_u64 << attempt;
                let delay_ms = rand::random_range(base_ms..=2 * base_ms);
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
            Err(DomainError::Api(error)) => return Err(error),
        }
    }
    Err(ApiError::unavailable())
}

pub async fn migrate(db: &DatabaseConnection) -> Result<(), ApiError> {
    let tx = begin(db).await?;
    // DDL-only lock; ordinary product/auth writes never acquire a global lock.
    tx.execute_unprepared("SELECT pg_advisory_xact_lock(783493421); CREATE TABLE IF NOT EXISTS hyori_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())").await?;
    for (version, source) in [
        (1_i32, include_str!("../migrations/0001_auth.sql")),
        (2_i32, include_str!("../migrations/0002_files_shares.sql")),
        (3_i32, include_str!("../migrations/0003_uploads.sql")),
        (4_i32, include_str!("../migrations/0004_photos.sql")),
        (5_i32, include_str!("../migrations/0005_account_purge.sql")),
        (6_i32, include_str!("../migrations/0006_derivatives.sql")),
        (
            7_i32,
            include_str!("../migrations/0007_upload_admission.sql"),
        ),
        (8_i32, include_str!("../migrations/0008_editors.sql")),
        (9_i32, include_str!("../migrations/0009_editor_runtime.sql")),
        (
            10_i32,
            include_str!("../migrations/0010_editor_save_mode.sql"),
        ),
        (
            11_i32,
            include_str!("../migrations/0011_editor_automatic_retention.sql"),
        ),
        (
            12_i32,
            include_str!("../migrations/0012_maintenance_backoff_and_upload_admission.sql"),
        ),
        (
            13_i32,
            include_str!("../migrations/0013_permanent_deletion.sql"),
        ),
        (
            14_i32,
            include_str!("../migrations/0014_owner_scoped_listing.sql"),
        ),
        (
            15_i32,
            include_str!("../migrations/0015_media_lease_settlement.sql"),
        ),
        (
            16_i32,
            include_str!("../migrations/0016_rate_limit_ceilings.sql"),
        ),
        (
            17_i32,
            include_str!("../migrations/0017_password_resets.sql"),
        ),
        (
            18_i32,
            include_str!("../migrations/0018_upload_idle_expiry.sql"),
        ),
        (
            19_i32,
            include_str!("../migrations/0019_link_capabilities.sql"),
        ),
        (
            20_i32,
            include_str!("../migrations/0020_thumbnail_geometry.sql"),
        ),
    ] {
        let checksum = hex::encode(Sha256::digest(source.as_bytes()));
        let old = tx
            .query_one_raw(sql(
                "SELECT checksum FROM hyori_migrations WHERE version = $1",
                vec![version.into()],
            ))
            .await?;
        if let Some(old) = old {
            if old.try_get::<String>("", "checksum")? != checksum {
                tracing::error!(version, "applied migration differs from this build");
                return Err(ApiError::unavailable());
            }
        } else {
            if version == 1 {
                let foreign = tx.query_one_raw(sql("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'hyori_migrations') AS present", vec![])).await?.ok_or_else(ApiError::unavailable)?;
                if foreign.try_get::<bool>("", "present")? {
                    return Err(ApiError::new(
                        crate::error::ErrorCode::Unavailable,
                        "Fresh dedicated PostgreSQL database required; no legacy importer is installed",
                    ));
                }
            }
            tx.execute_unprepared(source).await?;
            tx.execute_raw(sql(
                "INSERT INTO hyori_migrations(version, checksum) VALUES ($1, $2)",
                vec![version.into(), checksum.into()],
            ))
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

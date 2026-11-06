//! Bounded reclamation of expired authentication records, owned by the server runtime.

use crate::{auth::RATE_LIMIT_WINDOW_SECONDS, db, error::ApiError};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use std::time::Duration;
use tokio::{sync::watch, time::MissedTickBehavior};

/// Each pass deletes at most this many rows from each authentication table.
pub const AUTH_BATCH_SIZE: i64 = 256;
const AUTH_INTERVAL: Duration = Duration::from_secs(30);

/// Counts only committed deletions, never active records or pending work.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AuthCleanup {
    pub sessions: u64,
    pub grants: u64,
    pub invites: u64,
    pub rate_limits: u64,
}

/// One restart-safe pass. Database time, row locks and a repeated expiry predicate protect
/// concurrently refreshed records. SKIP LOCKED allows independent server processes to cooperate.
/// The existing transaction owner supplies statement/lock timeouts; no network side effects occur.
pub async fn reclaim_auth(db: &DatabaseConnection) -> Result<AuthCleanup, ApiError> {
    let tx = db::begin(db).await?;
    let sessions = tx.execute_raw(db::sql(
        "WITH expired AS (SELECT id FROM hyori_sessions WHERE expires_at <= statement_timestamp() ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM hyori_sessions AS dead USING expired WHERE dead.id = expired.id AND dead.expires_at <= statement_timestamp()",
        vec![AUTH_BATCH_SIZE.into()],
    )).await?.rows_affected();
    let grants = tx.execute_raw(db::sql(
        "WITH expired AS (SELECT token_digest FROM hyori_grants WHERE expires_at <= statement_timestamp() ORDER BY expires_at, token_digest LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM hyori_grants AS dead USING expired WHERE dead.token_digest = expired.token_digest AND dead.expires_at <= statement_timestamp()",
        vec![AUTH_BATCH_SIZE.into()],
    )).await?.rows_affected();
    let invites = tx.execute_raw(db::sql(
        "WITH expired AS (SELECT token_digest FROM hyori_invites WHERE expires_at <= statement_timestamp() ORDER BY expires_at, token_digest LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM hyori_invites AS dead USING expired WHERE dead.token_digest = expired.token_digest AND dead.expires_at <= statement_timestamp()",
        vec![AUTH_BATCH_SIZE.into()],
    )).await?.rows_affected();
    let rate_limits = tx.execute_raw(db::sql(
        "WITH expired AS (SELECT key_digest FROM hyori_rate_limits WHERE window_start <= statement_timestamp() - $2::bigint * interval '1 second' ORDER BY window_start, key_digest LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM hyori_rate_limits AS dead USING expired WHERE dead.key_digest = expired.key_digest AND dead.window_start <= statement_timestamp() - $2::bigint * interval '1 second'",
        vec![AUTH_BATCH_SIZE.into(), RATE_LIMIT_WINDOW_SECONDS.into()],
    )).await?.rows_affected();
    tx.commit().await?;
    Ok(AuthCleanup {
        sessions,
        grants,
        invites,
        rate_limits,
    })
}

/// Compose independently bounded authentication and upload reclamation under one runtime owner.
pub async fn run(state: std::sync::Arc<crate::AppState>, shutdown: watch::Receiver<bool>) {
    tokio::join!(
        run_auth(state.db.clone(), shutdown.clone()),
        run_accounts(state.clone(), shutdown.clone()),
        run_media(state.clone(), shutdown.clone()),
        run_editors(state.db.clone(), shutdown.clone()),
        run_uploads(state, shutdown)
    );
}
async fn run_editors(db: DatabaseConnection, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(AUTH_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! { biased; _=shutdown.changed()=>return, _=interval.tick()=>{} }
        tokio::select! { biased; _=shutdown.changed()=>return,
            result=crate::features::editors::cleanup::run_once(&db)=> {
                if let Err(error)=result { tracing::warn!(%error,"editor retention failed; next pass will retry"); }
            }
        }
    }
}
async fn run_media(state: std::sync::Arc<crate::AppState>, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! { biased; _=shutdown.changed()=>return, _=interval.tick()=>{} }
        tokio::select! { biased; _=shutdown.changed()=>return, result=async {
            crate::features::media::cleanup::reclaim(&state).await?;
            crate::features::media::jobs::run_once(&state).await
        } => {if let Err(error)=result { tracing::warn!(%error,"media maintenance failed; durable leases will recover"); }} }
    }
}
async fn run_accounts(state: std::sync::Arc<crate::AppState>, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! { biased; _ = shutdown.changed() => return, _ = interval.tick() => {} }
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            result = crate::features::admin::purge::reclaim(&state) => {
                if let Err(error) = result { tracing::warn!(%error, "account purge failed; durable lease expiry permits recovery"); }
            }
        }
    }
}
async fn run_uploads(state: std::sync::Arc<crate::AppState>, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        // Notify coalesces publication follow-ups; one worker owns bounded storage concurrency.
        tokio::select! { biased; _ = shutdown.changed() => return, _ = interval.tick() => {}, _ = state.upload_cleanup.notified() => {} }
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            result = async {
                crate::features::uploads::cleanup::reclaim_editors(&state).await?;
                crate::features::uploads::cleanup::reclaim(&state).await
            } => {
                if let Err(error) = result { tracing::warn!(%error, "upload cleanup failed; durable lease expiry permits recovery"); }
            }
        }
    }
}

/// Run immediately at startup and periodically thereafter; shutdown cancels the in-flight
/// transaction before the runtime closes its database pool. A failed pass is retried next tick.
pub async fn run_auth(db: DatabaseConnection, mut shutdown: watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(AUTH_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            _ = interval.tick() => {}
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            result = reclaim_auth(&db) => match result {
                Ok(counts) => tracing::debug!(?counts, "expired authentication records reclaimed"),
                Err(error) => tracing::warn!(%error, "authentication cleanup failed; next pass will retry"),
            }
        }
    }
}

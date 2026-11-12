//! Private, process-local telemetry. Labels come only from server-owned catalogs, never inputs.
use crate::{AppState, error::ErrorCode};
use axum::{
    body::Body,
    extract::{ConnectInfo, MatchedPath, State},
    http::{HeaderValue, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sea_orm::{ConnectionTrait, TransactionTrait};
use std::{
    collections::BTreeMap,
    fmt::Write,
    sync::{Arc, Mutex, OnceLock, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const BUCKETS: [f64; 11] = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1., 5., 30., 150.];
#[derive(Default)]
struct Histogram {
    count: u64,
    sum: f64,
    buckets: [u64; 11],
}
impl Histogram {
    fn observe(&mut self, seconds: f64) {
        self.count += 1;
        self.sum += seconds;
        for (limit, count) in BUCKETS.iter().zip(&mut self.buckets) {
            *count += u64::from(seconds <= *limit);
        }
    }
    fn render(&self, out: &mut String, name: &str, labels: &str) {
        for (limit, count) in BUCKETS.iter().zip(self.buckets) {
            let _ = writeln!(out, "{name}_bucket{{{labels},le=\"{limit}\"}} {count}");
        }
        let _ = writeln!(out, "{name}_bucket{{{labels},le=\"+Inf\"}} {}", self.count);
        let _ = writeln!(out, "{name}_count{{{labels}}} {}", self.count);
        let _ = writeln!(out, "{name}_sum{{{labels}}} {}", self.sum);
    }
}
#[derive(Default)]
struct Metrics {
    requests: BTreeMap<(&'static str, u16), Histogram>,
    admission: BTreeMap<(&'static str, &'static str), Histogram>,
    busy: BTreeMap<&'static str, u64>,
    maintenance: BTreeMap<&'static str, u64>,
    storage_errors: u64,
}
static METRICS: OnceLock<Mutex<Metrics>> = OnceLock::new();
fn metrics() -> std::sync::MutexGuard<'static, Metrics> {
    METRICS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// One of the fixed admission lanes; callers cannot introduce identity/path labels.
#[derive(Clone, Copy)]
pub(crate) enum Lane {
    Rpc,
    SignIn,
    Upload,
    UploadAuthorization,
}
impl Lane {
    fn label(self) -> &'static str {
        match self {
            Self::Rpc => "rpc",
            Self::SignIn => "sign_in",
            Self::Upload => "upload",
            Self::UploadAuthorization => "upload_authorization",
        }
    }
}
pub(crate) fn admission(lane: Lane, started: Instant, admitted: bool) {
    let mut metrics = metrics();
    metrics
        .admission
        .entry((lane.label(), if admitted { "admitted" } else { "refused" }))
        .or_default()
        .observe(started.elapsed().as_secs_f64());
    if !admitted {
        *metrics.busy.entry(lane.label()).or_default() += 1;
    }
}
pub(crate) fn storage_error() {
    metrics().storage_errors += 1;
}
pub(crate) fn maintained(task: &'static str) {
    metrics().maintenance.insert(
        task,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    );
}

/// Shared with the RPC parser so only a registered static name reaches telemetry.
#[derive(Clone, Default)]
pub(crate) struct Operation(pub Arc<OnceLock<&'static str>>);

pub(crate) async fn request(
    State(state): State<Arc<AppState>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let started = Instant::now();
    let request_id = crate::auth::random_token();
    let client = crate::rpc::client_address(
        request.headers(),
        request
            .extensions()
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .map(|info| info.0.ip()),
        &state.config.trusted_proxies,
    );
    let route = match request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
    {
        Some("/api/rpc") => "rpc.invalid",
        Some("/api/storage/uploads/{id}/{number}") => "storage.upload",
        Some("/api/storage/files/{id}") => "storage.file",
        Some("/api/storage/previews/{id}") => "storage.preview",
        Some("/api/storage/derivatives/{id}/{artifact}") => "storage.derivative",
        Some("/api/storage/editors/{id}") => "storage.editor",
        Some("/health/live") => "health.live",
        Some("/health/ready") => "health.ready",
        Some("/metrics") => "metrics",
        _ => "unknown",
    };
    let operation = Operation::default();
    request.extensions_mut().insert(operation.clone());
    let mut response = next.run(request).await;
    let operation = operation.0.get().copied().unwrap_or(route);
    let status = response.status().as_u16();
    let error_code = response
        .extensions()
        .get::<ErrorCode>()
        .and_then(|code| serde_json::to_value(code).ok());
    let elapsed = started.elapsed().as_secs_f64();
    metrics()
        .requests
        .entry((operation, status / 100))
        .or_default()
        .observe(elapsed);
    // Never record headers, URI, body, error messages, or a caller-supplied request ID.
    tracing::info!(target: "hyori_server::request", operation, status,
        error_code = error_code.as_ref().and_then(|code| code.as_str()).unwrap_or("none"),
        duration_seconds = elapsed, request_id, client_address = %client.map(|ip| ip.to_string()).unwrap_or_else(|| "unknown".into()),
        "request completed");
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

/// Scrapes do not share RPC admission. SQL has a short deadline; a failed scrape is a 503,
/// never a misleading healthy gauge. No storage calls or scans run on a product request.
pub(crate) async fn scrape(State(state): State<Arc<AppState>>) -> Response {
    match tokio::time::timeout(Duration::from_secs(2), snapshot(&state)).await {
        Ok(Ok(text)) => (
            [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
            text,
        )
            .into_response(),
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
async fn snapshot(state: &AppState) -> Result<String, crate::error::ApiError> {
    // The states are a fixed server-owned set; no job, owner, source key or failure text escapes.
    let tx = state.db.begin().await?;
    // Bound work in PostgreSQL too: dropping an HTTP future alone is not a SQL work budget.
    tx.execute_unprepared("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '500ms'").await?;
    let jobs = tx
        .query_all_raw(crate::db::sql(
            "SELECT state, count(*)::bigint AS count FROM hyori_media_jobs GROUP BY state",
            vec![],
        ))
        .await?;
    tx.commit().await?;
    let pool = state.db.get_postgres_connection_pool();
    let size = pool.size();
    let idle = pool.num_idle();
    let mut out = String::new();
    let _ = writeln!(
        out,
        "# HELP hyori_ready Whether the backend can query its database.\n# TYPE hyori_ready gauge\nhyori_ready 1"
    );
    let _ = writeln!(
        out,
        "# HELP hyori_database_pool_connections Current pool connections by state.\n# TYPE hyori_database_pool_connections gauge\nhyori_database_pool_connections{{state=\"idle\"}} {idle}\nhyori_database_pool_connections{{state=\"used\"}} {}\n# HELP hyori_database_pool_max_connections Configured connection ceiling.\n# TYPE hyori_database_pool_max_connections gauge\nhyori_database_pool_max_connections {}",
        size.saturating_sub(idle as u32),
        state.config.database_max_connections
    );
    let _ = writeln!(
        out,
        "# HELP hyori_transfers_in_flight Transfer permits held including streaming bodies.\n# TYPE hyori_transfers_in_flight gauge\nhyori_transfers_in_flight{{kind=\"download\"}} {}\nhyori_transfers_in_flight{{kind=\"upload\"}} {}",
        crate::config::DOWNLOAD_CONCURRENCY.saturating_sub(state.transfers.available_permits()),
        crate::config::UPLOAD_CONCURRENCY.saturating_sub(state.uploads.available_permits())
    );
    out.push_str(
        "# HELP hyori_media_jobs Durable jobs by bounded state.\n# TYPE hyori_media_jobs gauge\n",
    );
    for status in ["queued", "processing", "failed", "ready", "unsupported"] {
        let count = jobs
            .iter()
            .find(|row| {
                row.try_get::<String>("", "state")
                    .is_ok_and(|s| s == status)
            })
            .map(|row| row.try_get::<i64>("", "count"))
            .transpose()?
            .unwrap_or(0);
        let _ = writeln!(out, "hyori_media_jobs{{state=\"{status}\"}} {count}");
    }
    let metrics = metrics();
    out.push_str(
        "# HELP hyori_request_duration_seconds Time to response headers including admission.\n# TYPE hyori_request_duration_seconds histogram\n# HELP hyori_requests_total Completed requests by catalog operation and status class.\n# TYPE hyori_requests_total counter\n",
    );
    for ((operation, class), histogram) in &metrics.requests {
        let labels = format!("operation=\"{operation}\",status_class=\"{class}xx\"");
        histogram.render(&mut out, "hyori_request_duration_seconds", &labels);
        let _ = writeln!(out, "hyori_requests_total{{{labels}}} {}", histogram.count);
    }
    out.push_str(
        "# HELP hyori_admission_wait_seconds Time spent attempting admission by lane and outcome.\n# TYPE hyori_admission_wait_seconds histogram\n# HELP hyori_busy_refusals_total Refused admission attempts by lane.\n# TYPE hyori_busy_refusals_total counter\n",
    );
    for ((lane, outcome), histogram) in &metrics.admission {
        histogram.render(
            &mut out,
            "hyori_admission_wait_seconds",
            &format!("lane=\"{lane}\",outcome=\"{outcome}\""),
        );
    }
    for lane in [
        Lane::Rpc,
        Lane::SignIn,
        Lane::Upload,
        Lane::UploadAuthorization,
    ] {
        let lane = lane.label();
        let _ = writeln!(
            out,
            "hyori_busy_refusals_total{{lane=\"{lane}\"}} {}",
            metrics.busy.get(lane).copied().unwrap_or(0)
        );
    }
    let _ = writeln!(
        out,
        "# HELP hyori_storage_errors_total Failed original preview editor and cleanup storage operations.\n# TYPE hyori_storage_errors_total counter\nhyori_storage_errors_total {}",
        metrics.storage_errors
    );
    out.push_str("# HELP hyori_maintenance_last_success_timestamp_seconds Last successful pass in Unix seconds or zero before first success.\n# TYPE hyori_maintenance_last_success_timestamp_seconds gauge\n");
    for task in ["auth", "uploads", "accounts", "trash", "media", "editors"] {
        let _ = writeln!(
            out,
            "hyori_maintenance_last_success_timestamp_seconds{{task=\"{task}\"}} {}",
            metrics.maintenance.get(task).copied().unwrap_or(0)
        );
    }
    Ok(out)
}

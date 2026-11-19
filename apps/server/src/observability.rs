//! Private telemetry. Metric labels come only from server-owned catalogs, never inputs.
use crate::{AppState, error::ErrorCode};
use axum::{
    body::Body,
    extract::{ConnectInfo, MatchedPath, State},
    http::{HeaderValue, Method, Request},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sea_orm::ConnectionTrait;
use std::{
    collections::BTreeMap,
    fmt::Write,
    future::Future,
    net::IpAddr,
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
    if !admitted && matches!(lane, Lane::Upload | Lane::UploadAuthorization) {
        update_request(|fields| fields.refused_admission = Some(lane.label()));
    }
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

pub(crate) struct RequestLogDeployment {
    region: String,
    instance_id: String,
}

impl RequestLogDeployment {
    pub(crate) fn from_env() -> Self {
        let label = |name| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            region: label("HYORI_LOG_REGION").unwrap_or_else(|| "unknown".into()),
            instance_id: label("HYORI_LOG_INSTANCE_ID")
                .or_else(|| label("HOSTNAME"))
                .unwrap_or_else(|| "unknown".into()),
        }
    }
}

#[derive(Default)]
struct RequestFields {
    operation: &'static str,
    ended: bool,
    transfer_kind: Option<&'static str>,
    transfer_replay: Option<bool>,
    editor_intent: Option<&'static str>,
    editor_save_mode: Option<&'static str>,
    refused_admission: Option<&'static str>,
    failure: Option<Failure>,
}

pub(crate) struct Failure {
    pub category: &'static str,
    pub operation: Option<&'static str>,
    pub status: Option<u16>,
    pub sqlstate: Option<String>,
}

struct RequestContext {
    id: String,
    fields: Mutex<RequestFields>,
}

tokio::task_local! {
    static REQUEST_LOG: Option<Arc<RequestContext>>;
}

fn update_request<T>(update: impl FnOnce(&mut RequestFields) -> T) -> Option<T> {
    REQUEST_LOG
        .try_with(|context| {
            let mut fields = context
                .as_ref()?
                .fields
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            (!fields.ended).then(|| update(&mut fields))
        })
        .ok()
        .flatten()
}

/// Capture at the call site: Tokio does not inherit task-local state across a spawn.
pub(crate) fn inherit_request_log<T>(work: impl Future<Output = T>) -> impl Future<Output = T> {
    REQUEST_LOG.scope(REQUEST_LOG.try_with(Clone::clone).ok().flatten(), work)
}

pub(crate) fn request_id() -> Option<String> {
    REQUEST_LOG
        .try_with(|context| context.as_ref().map(|context| context.id.clone()))
        .ok()
        .flatten()
}

/// Only the RPC registry's owned operation name reaches telemetry.
pub(crate) fn operation(name: &'static str) {
    update_request(|fields| fields.operation = name);
}

pub(crate) fn transfer(kind: &'static str, replay: Option<bool>) {
    update_request(|fields| {
        fields.transfer_kind = Some(kind);
        fields.transfer_replay = replay;
    });
}

pub(crate) fn editor_save(intent: &'static str, mode: &'static str) {
    update_request(|fields| {
        fields.transfer_kind = Some("editor_save");
        fields.editor_intent = Some(intent);
        fields.editor_save_mode = Some(mode);
    });
}

/// Outside the pilot or after the request ends, the caller still emits a standalone error.
pub(crate) fn record_failure(failure: Failure) -> bool {
    update_request(|fields| {
        if !matches!(
            fields.operation,
            "uploads.begin"
                | "uploads.part"
                | "uploads.complete"
                | "storage.upload"
                | "editors.prepareSave"
                | "editors.completeSave"
        ) {
            return false;
        }
        if fields.failure.is_none() {
            fields.failure = Some(failure);
        }
        true
    })
    .unwrap_or(false)
}

struct RequestLog<'a> {
    context: Arc<RequestContext>,
    started: Instant,
    state: &'a AppState,
    method: &'static str,
    client: Option<IpAddr>,
    response: Option<(u16, Option<ErrorCode>)>,
}

impl Drop for RequestLog<'_> {
    fn drop(&mut self) {
        let fields = {
            let mut current = self
                .context
                .fields
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let snapshot = std::mem::take(&mut *current);
            current.ended = true;
            snapshot
        };
        let elapsed = self.started.elapsed().as_secs_f64();
        let status = self.response.as_ref().map(|(status, _)| *status);
        let outcome = match status.map(|status| status / 100) {
            Some(4) => "client_error",
            Some(5) => "server_error",
            Some(_) => "success",
            None if std::thread::panicking() => "server_error",
            None => "cancelled",
        };
        if let Some(status) = status {
            metrics()
                .requests
                .entry((fields.operation, status / 100))
                .or_default()
                .observe(elapsed);
        }
        let error_code = self
            .response
            .as_ref()
            .and_then(|(_, code)| code.as_ref())
            .and_then(|code| serde_json::to_value(code).ok());
        let failure = fields.failure.as_ref();
        tracing::info!(target: "hyori_server::request",
            event = "http.request.completed", service = env!("CARGO_PKG_NAME"),
            version = env!("CARGO_PKG_VERSION"),
            commit_hash = option_env!("HYORI_BUILD_COMMIT").filter(|value| !value.is_empty()).unwrap_or("unknown"),
            environment = if self.state.config.secure_cookies { "production" } else { "development" },
            region = self.state.request_log_deployment.region.as_str(),
            instance_id = self.state.request_log_deployment.instance_id.as_str(),
            method = self.method, operation = fields.operation, status, outcome,
            completion = if status.is_some() { "response_headers" } else { "before_headers" },
            error_code = error_code.as_ref().and_then(|code| code.as_str()).unwrap_or("none"),
            duration_seconds = elapsed, request_id = self.context.id.as_str(),
            client_address = %self.client.map(|ip| ip.to_string()).unwrap_or_else(|| "unknown".into()),
            transfer_kind = fields.transfer_kind, transfer_replay = fields.transfer_replay,
            editor_intent = fields.editor_intent, editor_save_mode = fields.editor_save_mode,
            refused_admission = fields.refused_admission,
            failure_category = failure.map(|f| f.category), failure_operation = failure.and_then(|f| f.operation),
            failure_status = failure.and_then(|f| f.status), failure_sqlstate = failure.and_then(|f| f.sqlstate.as_deref()),
            "request ended");
    }
}

pub(crate) async fn request(
    State(state): State<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let started = Instant::now();
    // HTTP allows caller-defined method tokens. Do not turn one into a log field.
    let method = match *request.method() {
        Method::GET => "GET",
        Method::HEAD => "HEAD",
        Method::POST => "POST",
        Method::PUT => "PUT",
        Method::DELETE => "DELETE",
        Method::CONNECT => "CONNECT",
        Method::OPTIONS => "OPTIONS",
        Method::TRACE => "TRACE",
        Method::PATCH => "PATCH",
        _ => "OTHER",
    };
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
        Some("/api/storage/notes/{id}") => "storage.note",
        Some("/api/storage/previews/{id}") => "storage.preview",
        Some("/api/storage/derivatives/{id}/{artifact}") => "storage.derivative",
        Some("/api/storage/editors/{id}") => "storage.editor",
        Some("/health/live") => "health.live",
        Some("/health/ready") => "health.ready",
        Some("/metrics") => "metrics",
        _ => "unknown",
    };
    let context = Arc::new(RequestContext {
        id: crate::auth::random_token(),
        fields: Mutex::new(RequestFields {
            operation: route,
            ..RequestFields::default()
        }),
    });
    // Own the summary outside the handler future: dropping it before headers still logs once.
    let mut log = RequestLog {
        context: context.clone(),
        started,
        state: &state,
        method,
        client,
        response: None,
    };
    let mut response = REQUEST_LOG
        .scope(Some(context.clone()), next.run(request))
        .await;
    log.response = Some((
        response.status().as_u16(),
        response.extensions().get::<ErrorCode>().cloned(),
    ));
    if let Ok(value) = HeaderValue::from_str(&context.id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

/// Scrapes do not share RPC admission. Optional SQL failures cannot hide process metrics.
/// No storage calls or scans run on a product request.
pub(crate) async fn scrape(State(state): State<Arc<AppState>>) -> Response {
    (
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        snapshot(&state).await,
    )
        .into_response()
}
async fn snapshot(state: &AppState) -> String {
    // Count cost and table locks must not determine readiness. Include pool acquisition in
    // each deadline, and avoid another pool wait when the cheap check already failed.
    let ready = matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            state.db.query_one_raw(crate::db::sql("SELECT 1", vec![])),
        )
        .await,
        Ok(Ok(Some(_)))
    );
    let jobs = if ready {
        tokio::time::timeout(Duration::from_secs(2), media_counts(state))
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    let pool = state.db.get_postgres_connection_pool();
    let size = pool.size();
    let idle = pool.num_idle();
    let mut out = String::new();
    let _ = writeln!(
        out,
        "# HELP hyori_ready Whether the backend can query its database.\n# TYPE hyori_ready gauge\nhyori_ready {}",
        u8::from(ready)
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
    let _ = writeln!(
        out,
        "# HELP hyori_media_jobs_available Whether this scrape read media job counts.\n# TYPE hyori_media_jobs_available gauge\nhyori_media_jobs_available {}",
        u8::from(jobs.is_some())
    );
    if let Some(jobs) = jobs {
        out.push_str(
            "# HELP hyori_media_jobs Durable jobs by bounded state.\n# TYPE hyori_media_jobs gauge\n",
        );
        for (status, count) in jobs {
            let _ = writeln!(out, "hyori_media_jobs{{state=\"{status}\"}} {count}");
        }
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
    out
}

async fn media_counts(
    state: &AppState,
) -> Result<Vec<(&'static str, i64)>, crate::error::ApiError> {
    // Bound work in PostgreSQL too: dropping an HTTP future alone is not a SQL work budget.
    let tx = crate::db::begin_owned(&state.db, None).await?;
    tx.execute_unprepared("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '1500ms'; SET LOCAL lock_timeout = '500ms'").await?;
    let jobs = tx
        .query_all_raw(crate::db::sql(
            "SELECT state, count(*)::bigint AS count FROM hyori_media_jobs GROUP BY state",
            vec![],
        ))
        .await?;
    tx.commit().await?;
    // The states are a fixed server-owned set; no job, owner, source key or failure text escapes.
    ["queued", "processing", "failed", "ready", "unsupported"]
        .into_iter()
        .map(|status| {
            let count = jobs
                .iter()
                .find(|row| {
                    row.try_get::<String>("", "state")
                        .is_ok_and(|s| s == status)
                })
                .map(|row| row.try_get::<i64>("", "count"))
                .transpose()?
                .unwrap_or(0);
            Ok((status, count))
        })
        .collect()
}

use crate::{
    AppState,
    config::MAX_JSON_BYTES,
    error::ApiError,
    wire::{ContractError, ContractResult, Manifest, manifest},
};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};

/// Candidate parsing permits bounded concurrent overflow; policy admits only the newest 16
/// database-validated public shares. Cookie names are only replacement/eviction addresses.
pub(crate) const MAX_GRANT_CANDIDATES: usize = 64;
pub(crate) const GRANT_COOKIE_PREFIX: &str = "hyori_grant_";
pub(crate) const DEVICE_COOKIE: &str = "hyori_device";

#[derive(Clone, Default)]
pub struct RequestContext {
    pub session: Option<String>,
    pub grants: Vec<String>,
    pub grant_cookie_names: Vec<String>,
    /// Unverified `hyori_device` cookie; the login rate limiter checks its MAC.
    pub device: Option<String>,
    /// TCP peer of this connection when the server was started with connect info. Behind the
    /// web host this is the web host, not the end client; forwarded headers are never trusted.
    pub peer: Option<std::net::IpAddr>,
}
impl RequestContext {
    /// Parse bounded credential material only. This is not authority: every product transaction
    /// resolves these tokens against current sessions, accounts, grants, and shares.
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let (grants, grant_cookie_names) = grant_cookies(headers);
        Self {
            session: session_cookie(headers),
            grants,
            grant_cookie_names,
            device: cookie(headers, DEVICE_COOKIE).filter(|value| value.len() <= 160),
            peer: None,
        }
    }
}
pub struct RpcResult<T> {
    pub value: T,
    pub cookies: Vec<String>,
}
impl<T> RpcResult<T> {
    pub fn value(value: T) -> Self {
        Self {
            value,
            cookies: vec![],
        }
    }
}
type HandlerFuture = Pin<Box<dyn Future<Output = Result<RpcResult<Value>, ApiError>> + Send>>;
type Handler = dyn Fn(Arc<AppState>, RequestContext, Value) -> HandlerFuture + Send + Sync;
struct Registered {
    input: jsonschema::Validator,
    output: jsonschema::Validator,
    handler: Option<Box<Handler>>,
}
pub struct RpcRegistry {
    manifest: Manifest,
    operations: HashMap<&'static str, Registered>,
}
impl RpcRegistry {
    /// Compile the composed feature validators once before accepting requests.
    pub fn new() -> ContractResult<Self> {
        Self::from_manifest(manifest()?)
    }
    /// Compile an explicit manifest, rejecting missing, invalid or duplicate declarations.
    pub fn from_manifest(manifest: Manifest) -> ContractResult<Self> {
        let definitions = serde_json::to_value(&manifest.schemas)?;
        let mut operations = HashMap::new();
        for operation in &manifest.operations {
            let validator = |name: &str| -> ContractResult<jsonschema::Validator> {
                let mut schema = manifest
                    .schemas
                    .get(name)
                    .ok_or_else(|| ContractError::MissingSchema(name.to_owned()))?
                    .clone();
                schema
                    .as_object_mut()
                    .ok_or_else(|| ContractError::InvalidSchema(name.to_owned()))?
                    .insert("$defs".into(), definitions.clone());
                jsonschema::options()
                    .should_validate_formats(true)
                    .build(&schema)
                    .map_err(|_| ContractError::InvalidValidator(name.to_owned()))
            };
            if !manifest.schemas.contains_key(operation.error) {
                return Err(ContractError::MissingSchema(operation.error.to_owned()));
            }
            let registered = Registered {
                input: validator(&operation.input)?,
                output: validator(&operation.output)?,
                handler: None,
            };
            if operations.insert(operation.name, registered).is_some() {
                return Err(ContractError::DuplicateOperation(operation.name));
            }
        }
        Ok(Self {
            manifest,
            operations,
        })
    }
    /// Each feature binds its implementation here; undeployed declarations remain explicit 404s.
    pub fn bind<I, O, F, Fut>(&mut self, name: &'static str, handler: F) -> ContractResult<()>
    where
        I: JsonSchema + DeserializeOwned + Send + 'static,
        O: JsonSchema + Serialize + Send + 'static,
        F: Fn(Arc<AppState>, RequestContext, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<RpcResult<O>, ApiError>> + Send + 'static,
    {
        let declared = self
            .manifest
            .operations
            .iter()
            .find(|operation| operation.name == name)
            .ok_or(ContractError::UndeclaredHandler(name))?;
        if declared.input != I::schema_name() || declared.output != O::schema_name() {
            return Err(ContractError::MismatchedHandler(name));
        }
        let registered = self
            .operations
            .get_mut(name)
            .ok_or(ContractError::UndeclaredHandler(name))?;
        if registered.handler.is_some() {
            return Err(ContractError::DuplicateHandler(name));
        }
        let handler = Arc::new(handler);
        registered.handler = Some(Box::new(move |state, context, input| {
            let handler = handler.clone();
            Box::pin(async move {
                let input = serde_json::from_value(input).map_err(|_| ApiError::invalid())?;
                let result = handler(state, context, input).await?;
                Ok(RpcResult {
                    value: serde_json::to_value(result.value)
                        .map_err(|_| ApiError::unavailable())?,
                    cookies: result.cookies,
                })
            })
        }));
        Ok(())
    }
    async fn dispatch(
        &self,
        state: Arc<AppState>,
        context: RequestContext,
        envelope: Envelope,
    ) -> Result<RpcResult<Value>, ApiError> {
        let operation = self
            .operations
            .get(envelope.operation.as_str())
            .ok_or_else(ApiError::not_found)?;
        let handler = operation.handler.as_ref().ok_or_else(ApiError::not_found)?;
        if !operation.input.is_valid(&envelope.input) {
            return Err(ApiError::invalid());
        }
        let result = handler(state, context, envelope.input).await?;
        if !operation.output.is_valid(&result.value) {
            tracing::error!(
                operation = envelope.operation,
                "response violated wire contract"
            );
            return Err(ApiError::unavailable());
        }
        Ok(result)
    }
}
#[derive(Deserialize)]
struct Envelope {
    operation: String,
    input: Value,
}
pub async fn handle(State(state): State<Arc<AppState>>, request: Request<Body>) -> Response {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        handle_inner(state, request),
    )
    .await
    .unwrap_or_else(|_| Err(ApiError::unavailable()));
    match result {
        Ok(result) => {
            let mut response =
                Json(serde_json::json!({ "ok": true, "value": result.value })).into_response();
            for cookie in result.cookies {
                match HeaderValue::from_str(&cookie) {
                    Ok(cookie) => {
                        response.headers_mut().append("set-cookie", cookie);
                    }
                    Err(_) => return ApiError::unavailable().into_response(),
                }
            }
            response
        }
        Err(error) => error.into_response(),
    }
}
async fn handle_inner(
    state: Arc<AppState>,
    request: Request<Body>,
) -> Result<RpcResult<Value>, ApiError> {
    let _admission = state
        .requests
        .try_acquire()
        .map_err(|_| ApiError::unavailable())?;
    validate_origin(request.headers(), &state.config.origin)?;
    if request
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        != Some("application/json")
    {
        return Err(ApiError::invalid());
    }
    let mut context = RequestContext::from_headers(request.headers());
    context.peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());
    let bytes = to_bytes(request.into_body(), MAX_JSON_BYTES)
        .await
        .map_err(|_| ApiError::invalid())?;
    let envelope: Envelope = serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid())?;
    state.rpc.dispatch(state.clone(), context, envelope).await
}
pub fn validate_origin(headers: &HeaderMap, origin: &str) -> Result<(), ApiError> {
    if headers.get_all("origin").iter().count() > 1 {
        return Err(ApiError::denied());
    }
    let supplied = headers.get("origin").and_then(|value| value.to_str().ok());
    let site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok());
    if site.is_some_and(|site| site != "same-origin" && site != "none") {
        return Err(ApiError::denied());
    }
    if supplied != Some(origin) && !(supplied.is_none() && site == Some("same-origin")) {
        return Err(ApiError::denied());
    }
    let expected = origin
        .split_once("://")
        .map(|(_, authority)| authority)
        .ok_or_else(ApiError::denied)?;
    if headers.get("host").and_then(|value| value.to_str().ok()) != Some(expected) {
        return Err(ApiError::denied());
    }
    Ok(())
}
/// Parse at most 64 candidates from at most 16 KiB of Cookie headers. The ordinary jar contains
/// <=16 independent per-share cookies; simultaneous additions can temporarily exceed that count.
/// Policy selects at most 16 current grants by DB creation time, and the next successful resolve
/// evicts overflow visible in its request. Neither cookie names nor their ordering confer authority.
/// The old aggregate cookie remains readable for its remaining 12-hour lifetime, but is never written.
fn grant_cookies(headers: &HeaderMap) -> (Vec<String>, Vec<String>) {
    let mut grants = Vec::new();
    let mut names = Vec::new();
    let mut bytes = 0usize;
    for header in headers.get_all("cookie") {
        bytes = bytes.saturating_add(header.as_bytes().len());
        let Ok(header) = header.to_str() else {
            return (vec![], vec![]);
        };
        if bytes > 16 * 1024 {
            return (vec![], vec![]);
        }
        for pair in header.split(';') {
            let Some((name, value)) = pair.trim().split_once('=') else {
                continue;
            };
            let legacy = name == "hyori_grants";
            if !legacy
                && !name
                    .strip_prefix(GRANT_COOKIE_PREFIX)
                    .is_some_and(valid_token)
            {
                continue;
            }
            if names.iter().any(|existing| existing == name) {
                return (vec![], vec![]);
            }
            names.push(name.to_owned());
            if legacy {
                if value.len() > 16 * 65 {
                    return (vec![], vec![]);
                }
                for token in value.split('.').take(17) {
                    if !valid_token(token) {
                        return (vec![], vec![]);
                    }
                    grants.push(token.to_owned());
                }
            } else if valid_token(value) {
                grants.push(value.to_owned());
            }
            if grants.len() > MAX_GRANT_CANDIDATES || names.len() > MAX_GRANT_CANDIDATES {
                return (vec![], vec![]);
            }
        }
    }
    grants.sort_unstable();
    grants.dedup();
    (grants, names)
}
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
/// The single value of a named cookie; absent when missing or repeated.
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut found = None;
    for header in headers.get_all("cookie") {
        for pair in header.to_str().ok()?.split(';') {
            if let Some((key, value)) = pair.trim().split_once('=')
                && key == name
            {
                if found.is_some() {
                    return None;
                }
                found = Some(value.to_owned());
            }
        }
    }
    found
}
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let mut session = None;
    for header in headers.get_all("cookie") {
        for pair in header.to_str().ok()?.split(';') {
            if let Some(("hyori_session", value)) = pair.trim().split_once('=') {
                if session.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return None;
                }
                session = Some(value.to_owned());
            }
        }
    }
    session
}
pub async fn no_store(request: Request<Body>, next: Next) -> Response {
    use crate::features::uploads::http::REVALIDATE_CACHE_CONTROL;
    let mut response = next.run(request).await;
    // Only the authorized immutable-media policy is exempt, never a future public/max-age
    // handler policy or an error carrying a copied success header.
    let revalidate = matches!(response.status().as_u16(), 200 | 206 | 304)
        && response.headers().get_all("cache-control").iter().count() == 1
        && response
            .headers()
            .get("cache-control")
            .is_some_and(|value| value == REVALIDATE_CACHE_CONTROL);
    if !revalidate {
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
    }
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}
pub async fn fallback() -> Response {
    ApiError::not_found().into_response()
}
pub async fn live() -> StatusCode {
    StatusCode::OK
}
pub async fn ready(State(state): State<Arc<AppState>>) -> Result<StatusCode, ApiError> {
    use sea_orm::ConnectionTrait;
    state
        .db
        .query_one_raw(crate::db::sql("SELECT 1", vec![]))
        .await?;
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod cache_policy_tests {
    use super::*;
    use crate::features::uploads::http::REVALIDATE_CACHE_CONTROL;
    use axum::{Router, middleware, routing::any};
    use tower::ServiceExt;

    #[tokio::test]
    async fn response_cache_policy_is_fail_closed_except_mandatory_revalidation() {
        let preview = "/api/storage/previews/file";
        let derivative = "/api/storage/derivatives/file/artifact";
        let revalidate = REVALIDATE_CACHE_CONTROL;
        for (path, status, policy, expected) in [
            ("/api/rpc", 200, None, "no-store"),
            ("/api/rpc", 400, None, "no-store"),
            ("/api/rpc", 200, Some("public, max-age=60"), "no-store"),
            (preview, 401, None, "no-store"),
            (preview, 403, Some(revalidate), "no-store"),
            (derivative, 404, None, "no-store"),
            (preview, 200, Some(revalidate), revalidate),
            (preview, 206, Some(revalidate), revalidate),
            (derivative, 304, Some(revalidate), revalidate),
            (preview, 200, Some("private, max-age=60"), "no-store"),
            (
                preview,
                200,
                Some("private, no-cache, max-age=60"),
                "no-store",
            ),
        ] {
            let router = Router::new()
                .route(
                    path,
                    any(move || async move {
                        let mut response = Response::new(Body::empty());
                        *response.status_mut() = StatusCode::from_u16(status).unwrap();
                        if let Some(policy) = policy {
                            response
                                .headers_mut()
                                .insert("cache-control", HeaderValue::from_static(policy));
                        }
                        response
                    }),
                )
                .layer(middleware::from_fn(no_store));
            let response = router
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(
                response.headers()["cache-control"],
                expected,
                "{path}: {status} {policy:?}"
            );
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        }
    }
}

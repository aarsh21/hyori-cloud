use crate::support::TestServer;
use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

pub async fn setup(server: &TestServer) -> (String, String) {
    let reply=server.rpc("auth.setup",json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    assert!(reply.cookie.is_some());
    (
        reply.value()["id"].as_str().unwrap().into(),
        reply.credential(),
    )
}
pub async fn account(server: &TestServer, admin: &str, email: &str) -> (String, String) {
    let password = random_token();
    let user = server
        .rpc(
            "admin.createUser",
            json!({"email":email,"name":"Private person","password":password}),
            Some(admin),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":email,"password":password}),
            None,
        )
        .await
        .credential();
    (user, cookie)
}
pub async fn folder(server: &TestServer, cookie: &str, name: &str) -> String {
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":name}),
            Some(cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
pub async fn begin(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    name: &str,
    replace: Option<&str>,
) -> String {
    let mut input = json!({"parentId":parent,"name":name,"size":101,"mimeType":"image/png"});
    if let Some(id) = replace {
        input["replaceId"] = json!(id);
    }
    server
        .rpc("uploads.begin", input, Some(cookie))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .into()
}
pub async fn part(server: &TestServer, cookie: &str, id: &str) {
    let response = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(include_bytes!("../fixtures/media/red.png").to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}
pub async fn upload(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    name: &str,
    replace: Option<&str>,
) -> Value {
    let id = begin(server, cookie, parent, name, replace).await;
    part(server, cookie, &id).await;
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()
        .clone()
}
pub async fn due(server: &TestServer) {
    server.state.db.execute_unprepared("UPDATE hyori_account_purges SET due_at=now(); UPDATE hyori_uploads SET cleanup_due=now()").await.unwrap();
}
pub async fn scalar(server: &TestServer, query: &str, id: &str) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(query, vec![id.into()]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap()
}

pub struct Faults {
    // 1: fail deletions after one actual delete; 2: hold begin before its storage effect;
    // 3: hold complete after its storage effect. Only this fixture's private endpoint is affected.
    pub mode: AtomicU8,
    pub allowed_key: std::sync::Mutex<String>,
    pub reached: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
}
pub struct Proxy {
    pub faults: Arc<Faults>,
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Proxy {
    pub async fn start(target: String) -> Self {
        use axum::{
            Router,
            body::{Body, HttpBody},
            http::{Request, Response, StatusCode},
        };
        let faults = Arc::new(Faults {
            mode: AtomicU8::new(0),
            allowed_key: std::sync::Mutex::new(String::new()),
            reached: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let state = faults.clone();
        let client = reqwest::Client::new();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let (faults, target, client) = (state.clone(), target.clone(), client.clone());
            async move {
                let (parts, body) = request.into_parts();
                let query = parts.uri.query().unwrap_or("");
                let beginning = parts.method == "POST" && query.contains("uploads");
                let completing = parts.method == "POST" && query.contains("uploadId=");
                let mode = faults.mode.load(Ordering::SeqCst);
                if mode == 1
                    && parts.method == "DELETE"
                    && !query.contains("uploadId=")
                    && !parts
                        .uri
                        .path()
                        .ends_with(faults.allowed_key.lock().unwrap().as_str())
                {
                    return Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Body::empty())
                        .unwrap();
                }
                if mode == 2 && beginning {
                    faults.reached.notify_one();
                    faults.release.notified().await;
                }
                let request = client
                    .request(parts.method, format!("{target}{}", parts.uri))
                    .headers(parts.headers);
                let request = if body.size_hint().exact() == Some(0) {
                    request.body(Vec::new())
                } else {
                    request.body(reqwest::Body::wrap_stream(body.into_data_stream()))
                };
                let result = request.send().await.unwrap();
                if mode == 3 && completing {
                    faults.reached.notify_one();
                    faults.release.notified().await;
                }
                let mut response = Response::builder().status(result.status());
                *response.headers_mut().unwrap() = result.headers().clone();
                response
                    .body(Body::from_stream(result.bytes_stream()))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            faults,
            endpoint,
            task,
        }
    }
}

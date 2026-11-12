use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

pub struct Proxy {
    pub fault: Arc<AtomicU8>,
    pub endpoint: String,
    pub read_entered: Arc<tokio::sync::Notify>,
    pub release_read: Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Proxy {
    pub async fn start(target: String) -> Self {
        use axum::{
            Router,
            body::{Body, HttpBody},
            http::{Request, Response, StatusCode},
        };
        let fault = Arc::new(AtomicU8::new(0));
        let control = fault.clone();
        let read_entered = Arc::new(tokio::sync::Notify::new());
        let release_read = Arc::new(tokio::sync::Notify::new());
        let entered = read_entered.clone();
        let release = release_read.clone();
        let client = reqwest::Client::new();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let (target, control, client, entered, release) = (
                target.clone(),
                control.clone(),
                client.clone(),
                entered.clone(),
                release.clone(),
            );
            async move {
                let (parts, body) = request.into_parts();
                let mode = control.load(Ordering::SeqCst);
                if ((mode == 4 && parts.method == "GET")
                    || (mode == 6
                        && parts.method == "DELETE"
                        && !parts.uri.query().unwrap_or("").contains("uploadId="))
                    || (mode == 5
                        && parts.method == "POST"
                        && parts.uri.query().unwrap_or("").contains("uploads")))
                    && control
                        .compare_exchange(mode, 0, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    entered.notify_one();
                    release.notified().await;
                }
                if mode == 2 || (mode == 3 && parts.method == "HEAD") {
                    return Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Body::empty())
                        .unwrap();
                }
                let lose = parts.method == "POST"
                    && ((mode == 1 && parts.uri.query().unwrap_or("").contains("uploads"))
                        || (mode == 3 && parts.uri.query().unwrap_or("").contains("uploadId=")));
                let request = client
                    .request(parts.method, format!("{target}{}", parts.uri))
                    .headers(parts.headers);
                let request = if body.size_hint().exact() == Some(0) {
                    request.body(Vec::new())
                } else {
                    request.body(reqwest::Body::wrap_stream(body.into_data_stream()))
                };
                let response = request.send().await.unwrap();
                if lose {
                    let _ = response.bytes().await.unwrap();
                    return Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Body::empty())
                        .unwrap();
                }
                let mut outgoing = Response::builder().status(response.status());
                *outgoing.headers_mut().unwrap() = response.headers().clone();
                outgoing
                    .body(Body::from_stream(response.bytes_stream()))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            fault,
            endpoint,
            read_entered,
            release_read,
            task,
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

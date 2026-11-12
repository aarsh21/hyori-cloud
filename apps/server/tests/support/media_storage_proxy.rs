use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
pub struct Proxy {
    pub lose_begin: Arc<AtomicBool>,
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Proxy {
    pub async fn start(target: String) -> Self {
        use axum::{
            Router,
            body::{Body, HttpBody},
            http::{Request, Response, StatusCode},
        };
        let lose_begin = Arc::new(AtomicBool::new(false));
        let fault = lose_begin.clone();
        let client = reqwest::Client::new();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let (target, fault, client) = (target.clone(), fault.clone(), client.clone());
            async move {
                let (parts, body) = request.into_parts();
                let lose = parts.method == "POST"
                    && parts.uri.path().contains("/derivatives/")
                    && parts.uri.query().unwrap_or("").contains("uploads")
                    && fault.load(Ordering::SeqCst);
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
                    assert!(response.status().is_success());
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
            lose_begin,
            endpoint,
            task,
        }
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

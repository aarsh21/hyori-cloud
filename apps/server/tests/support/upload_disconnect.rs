use axum::{
    Router,
    body::{Body, HttpBody},
    http::{Request, Response},
    middleware::{self, Next},
};
use hyori_server::{AppState, router};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::Notify};

pub struct StorageGate {
    pub endpoint: String,
    pub mode: Arc<AtomicU8>,
    pub reached: Arc<Notify>,
    pub release: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl StorageGate {
    pub async fn start(target: String) -> Self {
        let mode = Arc::new(AtomicU8::new(0));
        let reached = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (control, entered, resume) = (mode.clone(), reached.clone(), release.clone());
        let client = reqwest::Client::new();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let (target, control, entered, resume, client) = (
                target.clone(),
                control.clone(),
                entered.clone(),
                resume.clone(),
                client.clone(),
            );
            async move {
                let (parts, body) = request.into_parts();
                let selected = match control.load(Ordering::SeqCst) {
                    1 => {
                        parts.method == "POST"
                            && parts.uri.query().unwrap_or("").contains("uploadId=")
                    }
                    2 => {
                        parts.method == "PUT"
                            && parts.uri.query().unwrap_or("").contains("partNumber=")
                    }
                    _ => false,
                };
                let request = client
                    .request(parts.method, format!("{target}{}", parts.uri))
                    .headers(parts.headers);
                let request = if body.size_hint().exact() == Some(0) {
                    request.body(Vec::new())
                } else {
                    request.body(reqwest::Body::wrap_stream(body.into_data_stream()))
                };
                let response = request.send().await.unwrap();
                let status = response.status();
                let mut outgoing = Response::builder().status(status);
                *outgoing.headers_mut().unwrap() = response.headers().clone();
                let bytes = response.bytes().await.unwrap();
                if selected {
                    assert!(status.is_success());
                    control.store(0, Ordering::SeqCst);
                    entered.notify_one();
                    tokio::time::timeout(Duration::from_secs(45), resume.notified())
                        .await
                        .expect("test must release storage response");
                }
                outgoing.body(Body::from(bytes)).unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint,
            mode,
            reached,
            release,
            task,
        }
    }
}
impl Drop for StorageGate {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct RequestEnded(Arc<Notify>);
impl Drop for RequestEnded {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

/// An actual production router; observation does not control or cancel its handler.
pub struct ObservedServer {
    address: std::net::SocketAddr,
    pub ended: Arc<Notify>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}
impl ObservedServer {
    pub async fn start(state: Arc<AppState>) -> Self {
        let ended = Arc::new(Notify::new());
        let observed = ended.clone();
        let app = router(state).layer(middleware::from_fn(
            move |request: Request<Body>, next: Next| {
                let guard = RequestEnded(observed.clone());
                async move {
                    let _guard = guard;
                    next.run(request).await
                }
            },
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap()
        });
        Self {
            address,
            ended,
            stop: Some(stop),
            task,
        }
    }
    pub async fn stop_accepting(&mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: &[u8],
    ) -> std::net::TcpStream {
        let mut socket = tokio::net::TcpStream::connect(self.address).await.unwrap();
        socket.write_all(format!("{method} {path} HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        socket.write_all(body).await.unwrap();
        socket.into_std().unwrap()
    }
}
impl Drop for ObservedServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn signal(notify: &Notify) {
    tokio::time::timeout(Duration::from_secs(5), notify.notified())
        .await
        .expect("controlled phase must be observed");
}

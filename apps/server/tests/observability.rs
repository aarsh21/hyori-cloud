mod support;
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use support::{Postgres, TestServer};

#[derive(Clone)]
struct Log(Arc<Mutex<Vec<u8>>>);
impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
#[ignore = "isolated PostgreSQL; captures actual HTTP request logs and metrics"]
async fn request_logs_and_metric_labels_never_include_request_secrets() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Log(bytes.clone());
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter("hyori_server=info")
        .with_writer(move || writer.clone())
        .try_init()
        .unwrap();
    let mut pg = Postgres::start().await;
    pg.config.trusted_proxies = vec!["127.0.0.1".parse().unwrap()];
    let server = TestServer::start(pg.config.clone()).await;
    let email = "private-observability-email@example.test";
    let password = "private-observability-password-42!";
    let name = "private-observability-person";
    let folder = "private-observability-folder";
    let file = "private-observability-file.txt";
    let query = "private-observability-query";
    let token = "a123456789abcdefa123456789abcdefa123456789abcdefa123456789abcdefabc";
    let supplied_id = "private-observability-request-id";
    let setup = server.rpc("auth.setup", json!({"email":email,"password":password,"name":name,"setupToken":pg.config.setup_token}), None).await;
    setup.value();
    assert!(setup.cookie.is_some());
    let credential = setup.credential();
    let created = server
        .rpc_from(
            Some("198.51.100.42"),
            "files.createFolder",
            json!({"parentId":null,"name":folder}),
            Some(&credential),
        )
        .await;
    assert_eq!(created.value()["name"], folder);
    assert_eq!(
        server
            .rpc("files.list", json!({"search":folder}), Some(&credential))
            .await
            .status,
        200
    );
    server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .error(403, "access.denied");
    assert_eq!(
        server
            .rpc(supplied_id, json!({"name":file}), None)
            .await
            .status,
        404
    );
    let response = server
        .client
        .get(format!(
            "{}/api/storage/files/{file}?version={query}",
            server.url
        ))
        .header(
            "cookie",
            format!("hyori_session={token}; hyori_grant_{token}={token}"),
        )
        .header("authorization", format!("Bearer {password}"))
        .header("x-request-id", supplied_id)
        .header("host", "localhost:3001")
        .header("origin", &pg.config.origin)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503); // metadata-only fixture has no storage
    let generated = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_ne!(generated, supplied_id);
    let unknown = server
        .client
        .get(format!("{}/{file}?q={query}", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);
    let malformed = server
        .client
        .post(format!("{}/api/rpc", server.url))
        .header("host", "localhost:3001")
        .header("origin", &pg.config.origin)
        .header("content-type", "application/json")
        .body(format!("{{{email}"))
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);
    let scrape = server
        .client
        .get(format!("{}/metrics", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(scrape.status(), 200);
    assert!(
        scrape.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/plain; version=0.0.4")
    );
    let metrics = scrape.text().await.unwrap();
    assert!(
        metrics.contains("hyori_requests_total{operation=\"files.list\",status_class=\"2xx\"} 1")
    );
    assert!(
        metrics.contains("hyori_requests_total{operation=\"rpc.unknown\",status_class=\"4xx\"} 1")
    );
    assert!(
        metrics.contains("hyori_admission_wait_seconds_count{lane=\"rpc\",outcome=\"admitted\"} 5")
    );
    for metric in [
        "hyori_database_pool_connections",
        "hyori_transfers_in_flight",
        "hyori_media_jobs",
        "hyori_storage_errors_total",
        "hyori_maintenance_last_success_timestamp_seconds",
        "hyori_busy_refusals_total",
    ] {
        assert!(metrics.contains(metric), "missing {metric}");
    }
    let logs = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    let requests: Vec<_> = logs
        .lines()
        .filter(|line| line.contains("request completed"))
        .collect();
    assert_eq!(
        requests.len(),
        9,
        "exactly one line for every HTTP request: {logs}"
    );
    assert!(
        requests
            .iter()
            .any(|line| line.contains("files.createFolder") && line.contains("198.51.100.42"))
    );
    assert!(requests.iter().any(|line| line.contains("storage.file")
        && line.contains("service.unavailable")
        && line.contains(&generated)));
    for line in requests {
        for field in [
            "operation=",
            "status=",
            "error_code=",
            "duration_seconds=",
            "request_id=",
            "client_address=",
        ] {
            assert!(line.contains(field), "missing {field}: {line}");
        }
    }
    for secret in [
        email,
        password,
        name,
        folder,
        file,
        query,
        token,
        supplied_id,
        &credential,
        &pg.config.setup_token,
    ] {
        assert!(!logs.contains(secret), "request fixture secret in logs");
        assert!(
            !metrics.contains(secret),
            "request fixture secret in metrics"
        );
    }
    for cookie in credential.split("; ") {
        let (_, value) = cookie.split_once('=').unwrap();
        assert!(!logs.contains(value), "issued cookie value in logs");
        assert!(!metrics.contains(value), "issued cookie value in metrics");
    }
    assert!(metrics.contains("hyori_ready 1\n"));
    let counter = "hyori_requests_total{operation=\"files.list\",status_class=\"2xx\"} 1";
    let scrape = || async {
        let response = server
            .client
            .get(format!("{}/metrics", server.url))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let text = response.text().await.unwrap();
        assert!(text.contains(counter));
        for metric in [
            "hyori_admission_wait_seconds_count",
            "hyori_busy_refusals_total",
            "hyori_database_pool_connections",
            "hyori_transfers_in_flight",
            "hyori_storage_errors_total",
        ] {
            assert!(text.contains(metric), "missing process metric {metric}");
        }
        text
    };
    // SELECT 1 can still run, but the media count must hit its own database deadline.
    let lock = server.state.db.begin().await.unwrap();
    lock.execute_unprepared("LOCK TABLE hyori_media_jobs IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let blocked = scrape().await;
    assert!(blocked.contains("hyori_ready 1\n"));
    assert!(blocked.contains("hyori_media_jobs_available 0\n"));
    assert!(
        !blocked
            .lines()
            .any(|line| line.starts_with("hyori_media_jobs{"))
    );
    lock.rollback().await.unwrap();
    let recovered = scrape().await;
    assert!(recovered.contains("hyori_ready 1\n"));
    assert!(recovered.contains("hyori_media_jobs_available 1\n"));
    assert!(recovered.contains("hyori_media_jobs{state=\"queued\"} 0\n"));

    // Exhaust the existing pool without creating a second one for telemetry.
    let pool = server.state.db.get_postgres_connection_pool();
    let mut held = Vec::new();
    for _ in 0..pg.config.database_max_connections {
        held.push(pool.acquire().await.unwrap());
    }
    let exhausted = scrape().await;
    assert!(exhausted.contains("hyori_ready 0\n"));
    assert!(exhausted.contains("hyori_media_jobs_available 0\n"));
    assert!(
        !exhausted
            .lines()
            .any(|line| line.starts_with("hyori_media_jobs{"))
    );
    drop(held);
    pg.stop();
    let offline = scrape().await;
    assert!(offline.contains("hyori_ready 0\n"));
    assert!(offline.contains("hyori_media_jobs_available 0\n"));
    assert!(
        !offline
            .lines()
            .any(|line| line.starts_with("hyori_media_jobs{"))
    );
}

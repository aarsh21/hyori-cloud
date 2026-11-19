#[path = "support/upload_disconnect.rs"]
mod disconnect;
#[path = "support/storage.rs"]
mod storage;
mod support;
use disconnect::{ObservedServer, StorageGate, signal};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;
use std::{
    collections::HashSet,
    io::Write,
    sync::{Arc, Mutex, atomic::Ordering},
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
#[ignore = "isolated PostgreSQL and RustFS; captures actual HTTP request logs and metrics"]
async fn request_logs_and_metric_labels_never_include_request_secrets() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Log(bytes.clone());
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
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
    let custom_method = "PRIVATE-OBSERVABILITY-METHOD";
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
        .request(
            reqwest::Method::from_bytes(custom_method.as_bytes()).unwrap(),
            format!("{}/{file}?q={query}", server.url),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);
    let note = server
        .client
        .get(format!("{}/api/storage/notes/{file}?q={query}", server.url))
        .send()
        .await
        .unwrap();
    assert_eq!(note.status(), 400); // missing required fence, rejected by the framework
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
        metrics.contains("hyori_requests_total{operation=\"storage.note\",status_class=\"4xx\"} 1")
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
    let events: Vec<serde_json::Value> = logs
        .lines()
        .map(|line| serde_json::from_str(line).expect("one JSON object per log line"))
        .collect();
    let requests: Vec<_> = events
        .iter()
        .filter(|line| line["target"] == "hyori_server::request")
        .collect();
    assert_eq!(
        requests.len(),
        10,
        "exactly one line for every HTTP request: {logs}"
    );
    let fields = |operation: &str| {
        requests
            .iter()
            .find(|line| line["fields"]["operation"] == operation)
            .map(|line| &line["fields"])
            .unwrap_or_else(|| panic!("missing event for {operation}"))
    };
    let folder_event = fields("files.createFolder");
    assert_eq!(folder_event["method"], "POST");
    assert_eq!(folder_event["client_address"], "198.51.100.42");
    assert_eq!(folder_event["status"], 200);
    assert_eq!(folder_event["outcome"], "success");
    let file_event = fields("storage.file");
    assert_eq!(file_event["request_id"], generated);
    assert_eq!(file_event["status"], 503);
    assert_eq!(file_event["outcome"], "server_error");
    assert_eq!(file_event["error_code"], "service.unavailable");
    assert_eq!(fields("unknown")["method"], "OTHER");
    let note_event = fields("storage.note");
    assert_eq!(note_event["method"], "GET");
    assert_eq!(note_event["status"], 400);
    assert_eq!(note_event["outcome"], "client_error");
    assert_eq!(note_event["error_code"], "none");

    let mut request_ids = HashSet::new();
    for line in &requests {
        let fields = &line["fields"];
        assert!(line["timestamp"].as_str().is_some());
        assert_eq!(fields["event"], "http.request.completed");
        assert_eq!(fields["completion"], "response_headers");
        assert_eq!(fields["service"], "hyori-server");
        assert_eq!(fields["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(fields["environment"], "development");
        assert!(fields["duration_seconds"].as_f64().unwrap() >= 0.0);
        for key in ["commit_hash", "region", "instance_id"] {
            assert!(fields[key].as_str().is_some_and(|value| !value.is_empty()));
        }
        let request_id = fields["request_id"].as_str().unwrap();
        assert!(!request_id.is_empty() && request_ids.insert(request_id));
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
        custom_method,
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
    transfer_events(&server, &credential, &bytes).await;
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

async fn transfer_events(metadata: &TestServer, credential: &str, bytes: &Mutex<Vec<u8>>) {
    let start = bytes.lock().unwrap().len();
    let records = || {
        let bytes = bytes.lock().unwrap();
        std::str::from_utf8(&bytes[start..])
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["fields"].clone())
            .collect::<Vec<_>>()
    };
    let secret = "private-editor-save-id";
    metadata
        .rpc(
            "editors.prepareSave",
            json!({
                "sessionId":"private-editor-session", "saveId":secret, "expectedRevision":"0",
                "name":"private-editor-file.pdf", "size":3, "sha256":"a".repeat(64),
                "intent":"replace", "saveMode":"automatic"
            }),
            Some(credential),
        )
        .await
        .error(503, "service.unavailable");
    let editor = records()
        .into_iter()
        .find(|event| event["operation"] == "editors.prepareSave")
        .unwrap();
    assert_eq!(editor["transfer_kind"], "editor_save");
    assert_eq!(editor["editor_intent"], "replace");
    assert_eq!(editor["editor_save_mode"], "automatic");

    let fs = storage::RustFs::start().await;
    let gate = StorageGate::start(fs.config.endpoint.clone()).await;
    let mut config = (*metadata.state.config).clone();
    config.storage = Some(hyori_storage::StorageConfig {
        endpoint: gate.endpoint.clone(),
        ..fs.config.clone()
    });
    let server = TestServer::start(config).await;
    let upload = server.rpc("uploads.begin", json!({
        "parentId":null,"name":"private-upload-name.bin","size":3,"mimeType":"application/octet-stream",
    }), Some(credential)).await.value()["uploadId"].as_str().unwrap().to_owned();
    let path = format!("/api/storage/uploads/{upload}/1");
    let put = || {
        server
            .client
            .put(format!("{}{path}", server.url))
            .header("host", "localhost:3001")
            .header("origin", &server.state.config.origin)
            .header("cookie", credential)
            .body("abc")
    };

    gate.mode.store(3, Ordering::SeqCst);
    let (response, ()) = tokio::join!(put().send(), async {
        signal(&gate.reached).await;
        gate.release.notify_one();
    });
    let response = response.unwrap();
    assert_eq!(response.status(), 503);
    let attended_id = response.headers()["x-request-id"].to_str().unwrap();
    let events = records();
    let attended: Vec<_> = events
        .iter()
        .filter(|event| event["request_id"] == attended_id)
        .collect();
    assert_eq!(
        attended.len(),
        1,
        "request-bound failure must not log twice"
    );
    assert_eq!(attended[0]["failure_category"], "storage");
    assert_eq!(attended[0]["failure_operation"], "part");
    assert_eq!(attended[0]["failure_status"], 503);
    assert_eq!(attended[0]["transfer_kind"], "new_file");
    assert_eq!(attended[0]["transfer_replay"], false);

    let mut observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(3, Ordering::SeqCst);
    let socket = observed.request("PUT", &path, credential, b"abc").await;
    signal(&gate.reached).await;
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    let cancelled: Vec<_> = records()
        .into_iter()
        .filter(|event| event["outcome"] == "cancelled")
        .collect();
    assert_eq!(cancelled.len(), 1);
    let cancelled = &cancelled[0];
    assert_eq!(cancelled["operation"], "storage.upload");
    assert_eq!(cancelled["completion"], "before_headers");
    assert!(cancelled.get("status").is_none());
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let response = put().send().await.unwrap();
            if response.status() == 200 {
                break;
            }
            assert_eq!(response.status(), 409, "lease may still be releasing");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    let replay = put().send().await.unwrap();
    assert_eq!(replay.status(), 200);
    let replay_id = replay.headers()["x-request-id"].to_str().unwrap();
    let events = records();
    let late = events
        .iter()
        .filter(|event| event["request_id"] == cancelled["request_id"])
        .collect::<Vec<_>>();
    assert_eq!(
        late.len(),
        2,
        "the late worker failure must be separate, not lost"
    );
    assert_eq!(late[1]["message"], "storage operation failed");
    assert_eq!(
        events
            .iter()
            .find(|event| event["request_id"] == replay_id)
            .unwrap()["transfer_replay"],
        true
    );
    observed.stop_accepting().await;
    let logs = bytes.lock().unwrap();
    let logs = std::str::from_utf8(&logs[start..]).unwrap();
    for private in [
        upload.as_str(),
        secret,
        "private-upload-name.bin",
        "private-editor-file.pdf",
        "private-editor-session",
    ] {
        assert!(
            !logs.contains(private),
            "private transfer metadata must not be logged"
        );
    }
}

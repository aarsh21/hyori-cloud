#[expect(dead_code, reason = "shared media fixture")]
#[path = "support/media_worker.rs"]
mod media_worker;
#[path = "support/storage.rs"]
mod storage;
#[expect(dead_code, reason = "shared authentication fixture")]
mod support;

use axum::{body::Body, extract::Request, response::IntoResponse};
use hyori_server::{auth::random_token, db::sql, features::media::jobs};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use support::{Postgres, TestServer};

async fn upload(server: &TestServer, cookie: &str, name: &str, mime: &str, bytes: &[u8]) -> Value {
    let begun = server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":name,"mimeType":mime,"size":bytes.len()}),
            Some(cookie),
        )
        .await;
    let id = begun.value()["uploadId"].as_str().unwrap();
    let response = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()
        .clone()
}

async fn relay(listener: tokio::net::TcpListener, upstream: String) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let Ok((mut inbound, _)) = listener.accept().await else {
            return;
        };
        let upstream = upstream.clone();
        connections.spawn(async move {
            if let Ok(mut outbound) = tokio::net::TcpStream::connect(&upstream).await {
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
            }
        });
    }
}

async fn snapshot(server: &TestServer) -> Value {
    server.state.db.query_one_raw(sql("SELECT jsonb_agg(jsonb_build_object('name',i.name,'state',j.state,'attempts',j.attempts,'failure',j.failure,'detail',j.failure_detail,'decoder',j.decoder_revision,'artifact',j.artifact_id) ORDER BY i.name) AS rows FROM hyori_media_jobs j JOIN hyori_items i ON i.object_key=j.source_key", vec![])).await.unwrap().unwrap().try_get("", "rows").unwrap()
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker with injected decoder deadline replies"]
async fn decoder_deadlines_exhaust_three_attempts_without_poisoning_infrastructure_recovery() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = fs.config.endpoint.trim_start_matches("http://").to_owned();
    let running = tokio::spawn(relay(listener, upstream.clone()));
    let mut relayed = fs.config.clone();
    relayed.endpoint = format!("http://{address}");
    let busy = Arc::new(AtomicBool::new(true));
    let proxy_path = worker.socket.with_file_name("deadline.sock");
    let listener = tokio::net::UnixListener::bind(&proxy_path).unwrap();
    // Inject only deadline/Busy replies. Identity and successful work use the isolated worker;
    // uploads, interrupted source reads and publication use real RustFS through the TCP relay.
    let app = axum::Router::new().fallback({
        let busy = busy.clone();
        let client = worker.client();
        move |request: Request| {
            let client = client.clone();
            let busy = busy.clone();
            async move {
                if request.method() == axum::http::Method::POST {
                    let stage = match request.headers().get("x-hyori-media-type").and_then(|v| v.to_str().ok()) {
                        Some("image/png") => Some("probe"),
                        Some("image/webp") => Some("encode"),
                        _ => None,
                    };
                    if let Some(stage) = stage {
                        return (axum::http::StatusCode::REQUEST_TIMEOUT, axum::Json(json!({"error":"timeout","diagnostic":{"stage":stage,"reason":"deadline"}}))).into_response();
                    }
                    if busy.load(Ordering::SeqCst) {
                        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error":"busy"}))).into_response();
                    }
                }
                let (parts, body) = request.into_parts();
                let response = client.request(parts.method, format!("http://localhost{}", parts.uri))
                    .headers(parts.headers).body(reqwest::Body::wrap_stream(body.into_data_stream()))
                    .send().await.unwrap();
                let status = response.status();
                let headers = response.headers().clone();
                let mut response = (status, Body::from(response.bytes().await.unwrap())).into_response();
                *response.headers_mut() = headers;
                response
            }
        }
    });
    let proxy = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    pg.config.storage = Some(relayed);
    pg.config.media_worker_socket = Some(proxy_path);
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}), None).await;
    let cookie = admin.credential();
    upload(
        &server,
        &cookie,
        "probe.png",
        "image/png",
        include_bytes!("fixtures/media/red.png"),
    )
    .await;
    upload(
        &server,
        &cookie,
        "encode.webp",
        "image/webp",
        include_bytes!("fixtures/media/red.webp"),
    )
    .await;
    let survivor = upload(
        &server,
        &cookie,
        "survivor.jpg",
        "image/jpeg",
        include_bytes!("fixtures/media/red.jpg"),
    )
    .await;
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET state='failed',attempts=3,failure='unavailable',decoder_revision='older'").await.unwrap();
    for _ in 0..3 {
        jobs::run_once(&server.state).await.unwrap();
    }
    let before_outage = snapshot(&server).await;
    println!("DEADLINE first wave: {before_outage}");
    let survivor_row = before_outage
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "survivor.jpg")
        .unwrap();
    assert_eq!(survivor_row["failure"], "busy");
    assert_eq!(survivor_row["attempts"], 0);

    running.abort();
    let _ = running.await;
    // Accelerate only stored due times; the unchanged lead_outage test waits the natural backoff.
    server
        .state
        .db
        .execute_unprepared("UPDATE hyori_media_jobs SET due_at=now() WHERE state='queued'")
        .await
        .unwrap();
    for _ in 0..3 {
        jobs::run_once(&server.state).await.unwrap();
    }
    let after_outage = snapshot(&server).await;
    println!("DEADLINE storage outage: {after_outage}");
    for (before, after) in before_outage
        .as_array()
        .unwrap()
        .iter()
        .zip(after_outage.as_array().unwrap())
    {
        assert_eq!(after["state"], "queued");
        assert_eq!(after["failure"], "unavailable");
        assert_eq!(
            after["attempts"], before["attempts"],
            "storage failure must preserve prior decoder attempts"
        );
    }
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let running = tokio::spawn(relay(listener, upstream));
    busy.store(false, Ordering::SeqCst);
    for _ in 0..2 {
        server
            .state
            .db
            .execute_unprepared("UPDATE hyori_media_jobs SET due_at=now() WHERE state='queued'")
            .await
            .unwrap();
        for _ in 0..3 {
            jobs::run_once(&server.state).await.unwrap();
        }
    }
    let completed = snapshot(&server).await;
    println!("DEADLINE completed wave: {completed}");
    for row in completed.as_array().unwrap() {
        if row["name"] == "survivor.jpg" {
            assert_eq!(row["state"], "ready");
            assert_eq!(row["attempts"], 1);
            assert_eq!(row["failure"], Value::Null);
        } else {
            assert_eq!(
                row["state"], "failed",
                "decoder deadline must exhaust after three attempts"
            );
            assert_eq!(row["attempts"], 3);
            assert_eq!(row["failure"], "timeout");
            assert_eq!(row["detail"]["reason"], "deadline");
            assert_eq!(
                row["detail"]["stage"],
                if row["name"] == "probe.png" {
                    "probe"
                } else {
                    "encode"
                }
            );
        }
    }
    let listing = server.rpc("files.list", json!({}), Some(&cookie)).await;
    assert!(listing.value()["thumbnails"][survivor["id"].as_str().unwrap()]["url"].is_string());
    drop(server);
    let server = TestServer::start(pg.config.clone()).await;
    for _ in 0..10 {
        assert!(
            !jobs::run_once(&server.state).await.unwrap(),
            "same-fingerprint discovery must not repair a decoder verdict"
        );
    }
    assert_eq!(snapshot(&server).await, completed);
    println!(
        "DEADLINE same-fingerprint restart: two failed/3/deadline rows unchanged; survivor ready/1"
    );
    proxy.abort();
    running.abort();
}

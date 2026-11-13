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
    atomic::{AtomicU8, Ordering},
};
use support::{Postgres, TestServer};

async fn upload(server: &TestServer, cookie: &str, name: &str) -> Value {
    let bytes = include_bytes!("fixtures/media/red.png");
    let begun = server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":name,"mimeType":"image/png","size":bytes.len()}),
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

async fn snapshot(server: &TestServer) -> Value {
    server.state.db.query_one_raw(sql("SELECT jsonb_agg(jsonb_build_object('state',state,'attempts',attempts,'failures',upgrade_failures,'failure',failure,'decoder',decoder_revision,'due',due_at,'artifact',artifact_id) ORDER BY id) AS rows FROM hyori_media_jobs", vec![])).await.unwrap().unwrap().try_get("", "rows").unwrap()
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker with private-socket transport fault injection"]
async fn infrastructure_failures_back_off_survive_restarts_and_yield_to_new_uploads() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    let proxy_path = worker.socket.with_file_name("fault.sock");
    let listener = tokio::net::UnixListener::bind(&proxy_path).unwrap();
    let fault = Arc::new(AtomicU8::new(0));
    // Only the fault response is injected. Decoder identity and successful derivations go through
    // the actual isolated worker; inputs/publication still use real RustFS and production APIs.
    let app = axum::Router::new().fallback({
        let fault = fault.clone();
        let client = worker.client();
        move |request: Request| {
            let client = client.clone();
            let mode = fault.load(Ordering::SeqCst);
            async move {
                if request.method() == axum::http::Method::POST && mode != 0 {
                    return (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        axum::Json(json!({"error":if mode == 1 {"busy"} else {"timeout"}})),
                    )
                        .into_response();
                }
                let (parts, body) = request.into_parts();
                let response = client
                    .request(parts.method, format!("http://localhost{}", parts.uri))
                    .headers(parts.headers)
                    .body(reqwest::Body::wrap_stream(body.into_data_stream()))
                    .send()
                    .await
                    .unwrap();
                let status = response.status();
                let headers = response.headers().clone();
                let mut response =
                    (status, Body::from(response.bytes().await.unwrap())).into_response();
                *response.headers_mut() = headers;
                response
            }
        }
    });
    let proxy = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    pg.config.storage = Some(fs.config.clone());
    pg.config.media_worker_socket = Some(proxy_path);
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}), None).await;
    let cookie = admin.credential();
    upload(&server, &cookie, "ready-control.png").await;
    jobs::run_once(&server.state).await.unwrap();
    let ready = snapshot(&server).await;
    for name in ["v1-busy.png", "v1-timeout.png", "v1-unavailable.png"] {
        upload(&server, &cookie, name).await;
    }
    // Reproduce v1's already-poisoned current-fingerprint rows, not just a fresh upgrade.
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs j SET state='failed',attempts=1,upgrade_retry=true,decoder_revision=(SELECT decoder_revision FROM hyori_media_jobs WHERE state='ready' LIMIT 1),failure=CASE i.name WHEN 'v1-busy.png' THEN 'busy' WHEN 'v1-timeout.png' THEN 'timeout' ELSE 'unavailable' END FROM hyori_items i WHERE i.object_key=j.source_key AND j.state='queued'").await.unwrap();
    for failure in 1..=8 {
        fault.store(if failure % 2 == 1 { 1 } else { 2 }, Ordering::SeqCst);
        if failure > 1 {
            // Advance only the stored due time to exercise later backoff tiers without a 40-minute
            // test. lead_outage independently waits for the real first deadline without SQL edits.
            server
                .state
                .db
                .execute_unprepared("UPDATE hyori_media_jobs SET due_at=now() WHERE state='queued'")
                .await
                .unwrap();
        }
        for _ in 0..3 {
            assert!(jobs::run_once(&server.state).await.unwrap());
        }
        let row = server.state.db.query_one_raw(sql("SELECT count(*)::bigint AS n,min(extract(epoch FROM due_at-now()))::double precision AS delay,min(upgrade_failures) AS failures,max(attempts) AS attempts,min(failure) AS reason FROM hyori_media_jobs WHERE state='queued'", vec![])).await.unwrap().unwrap();
        let delay = row.try_get::<f64>("", "delay").unwrap();
        let expected = (10 * (1 << failure.min(6))) as f64;
        assert_eq!(
            row.try_get::<String>("", "reason").unwrap(),
            if failure % 2 == 1 { "busy" } else { "timeout" }
        );
        println!(
            "RECOVERY fault={failure} queued={} attempts={} counter={} delay={delay:.3}s expected={expected}s",
            row.try_get::<i64>("", "n").unwrap(),
            row.try_get::<i32>("", "attempts").unwrap(),
            row.try_get::<i32>("", "failures").unwrap()
        );
        assert_eq!(row.try_get::<i64>("", "n").unwrap(), 3);
        assert_eq!(row.try_get::<i32>("", "attempts").unwrap(), 0);
        assert_eq!(row.try_get::<i32>("", "failures").unwrap(), failure.min(6));
        assert!(delay > expected - 2.0 && delay <= expected);
        let before = snapshot(&server).await;
        for _ in 0..10 {
            assert!(!jobs::run_once(&server.state).await.unwrap());
        }
        assert_eq!(
            snapshot(&server).await,
            before,
            "no hot loop while the fault lasts"
        );
    }
    let before = snapshot(&server).await;
    drop(server);
    worker.stop();
    worker.restart().await;
    let server = TestServer::start(pg.config.clone()).await;
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(
        snapshot(&server).await,
        before,
        "same-decoder restart preserves backoff"
    );

    // A lease lost in a crash uses the identical durable policy, not a terminal decoder verdict.
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET state='processing',attempts=1,lease_token='lost-process',lease_until=now()-interval '1 second',due_at=now() WHERE state='queued'").await.unwrap();
    drop(server);
    let server = TestServer::start(pg.config.clone()).await;
    jobs::run_once(&server.state).await.unwrap();
    let after = snapshot(&server).await;
    assert_eq!(
        after
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["state"] == "queued"
                && r["attempts"] == 0
                && r["failure"] == "timeout"
                && r["failures"] == 6)
            .count(),
        3
    );
    assert_eq!(
        after
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["state"] == "ready")
            .collect::<Vec<_>>(),
        ready.as_array().unwrap().iter().collect::<Vec<_>>()
    );

    fault.store(0, Ordering::SeqCst);
    server
        .state
        .db
        .execute_unprepared("UPDATE hyori_media_jobs SET due_at=now() WHERE state='queued'")
        .await
        .unwrap();
    let start = std::time::Instant::now();
    let fresh = upload(&server, &cookie, "new-during-fault-recovery.png").await;
    jobs::run_once(&server.state).await.unwrap();
    let listing = server.rpc("files.list", json!({}), Some(&cookie)).await;
    assert!(listing.value()["thumbnails"][fresh["id"].as_str().unwrap()]["url"].is_string());
    assert_eq!(
        snapshot(&server)
            .await
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["state"] == "queued")
            .count(),
        3,
        "exactly one job ran, and it was the fresh upload"
    );
    println!(
        "RECOVERY fresh upload ready in {:.3}ms, all three due recovery jobs still queued",
        start.elapsed().as_secs_f64() * 1000.0
    );
    for _ in 0..3 {
        jobs::run_once(&server.state).await.unwrap();
    }
    assert!(
        snapshot(&server)
            .await
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["state"] == "ready" && r["attempts"] == 1)
    );
    proxy.abort();
}

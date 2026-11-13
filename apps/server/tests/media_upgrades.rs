#[expect(
    dead_code,
    reason = "This suite uses only the shared fixture's media setup"
)]
#[path = "support/media_worker.rs"]
mod media_worker;
#[path = "support/storage.rs"]
mod storage;
#[expect(
    dead_code,
    reason = "Other shared auth assertions belong to their own suites"
)]
mod support;
use hyori_server::{auth::random_token, features::media::jobs};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, TestServer};

async fn upload(server: &TestServer, cookie: &str, name: &str, bytes: &[u8]) -> Value {
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

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker decoder upgrade and listing contract"]
async fn decoder_upgrade_retries_terminal_jobs_once_without_delaying_new_files() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    pg.config.storage = Some(fs.config.clone());
    pg.config.media_worker_socket = Some(worker.socket.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}), None).await;
    let cookie = admin.credential();
    let png = include_bytes!("fixtures/media/red.png");
    let ready = upload(&server, &cookie, "ready.png", png).await;
    jobs::run_once(&server.state).await.unwrap();
    let first = server.rpc("files.list", json!({}), Some(&cookie)).await;
    let ready_url = first.value()["thumbnails"][ready["id"].as_str().unwrap()]["url"].clone();
    assert!(ready_url.is_string());
    let recoverable = upload(&server, &cookie, "older-failed.png", png).await;
    let other = upload(&server, &cookie, "older-unsupported.png", png).await;
    let corrupt = upload(&server, &cookie, "corrupt.png", b"\x89PNG\r\n\x1a\ninvalid").await;
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET state='unsupported',failure='invalidMedia',attempts=3,decoder_revision='older' WHERE state='queued'").await.unwrap();
    // One was an exhausted retryable failure, not a codec rejection.
    server.state.db.execute_unprepared(&format!("UPDATE hyori_media_jobs j SET state='failed',failure='unavailable' FROM hyori_items i WHERE i.object_key=j.source_key AND i.id='{}'", recoverable["id"].as_str().unwrap())).await.unwrap();
    jobs::run_once(&server.state).await.unwrap(); // requeue the wave and finish exactly one
    let fresh = upload(&server, &cookie, "new-during-wave.png", png).await;
    jobs::run_once(&server.state).await.unwrap();
    let listing = server.rpc("files.list", json!({}), Some(&cookie)).await;
    assert!(
        listing.value()["thumbnails"][fresh["id"].as_str().unwrap()]["url"].is_string(),
        "new work overtakes an already queued upgrade wave"
    );
    for _ in 0..8 {
        jobs::run_once(&server.state).await.unwrap();
    }
    let listing = server.rpc("files.list", json!({}), Some(&cookie)).await;
    for item in [&recoverable, &other] {
        assert!(listing.value()["thumbnails"][item["id"].as_str().unwrap()]["url"].is_string());
    }
    assert_eq!(
        listing.value()["thumbnails"][ready["id"].as_str().unwrap()]["url"],
        ready_url,
        "ready artifacts survive decoder upgrades"
    );
    assert_eq!(
        listing.value()["thumbnails"][corrupt["id"].as_str().unwrap()],
        json!({"url":null,"pending":false})
    );
    let row = server.state.db.query_one_raw(hyori_server::db::sql("SELECT attempts,failure_detail FROM hyori_media_jobs j JOIN hyori_items i ON i.object_key=j.source_key WHERE i.id=$1", vec![corrupt["id"].as_str().unwrap().into()])).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i32>("", "attempts").unwrap(), 1);
    assert_eq!(
        row.try_get::<Value>("", "failure_detail").unwrap()["stage"],
        "probe"
    );
    worker.stop();
    worker.restart().await;
    for _ in 0..8 {
        jobs::run_once(&server.state).await.unwrap();
    }
    let attempts = server
        .state
        .db
        .query_one_raw(hyori_server::db::sql(
            "SELECT max(attempts) AS attempts FROM hyori_media_jobs",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        attempts.try_get::<i32>("", "attempts").unwrap(),
        1,
        "same decoder restart retries nothing, including truly unsupported input"
    );
    assert!(
        !listing.value().to_string().contains("failureDetail"),
        "operator diagnostics stay off the product wire"
    );
}

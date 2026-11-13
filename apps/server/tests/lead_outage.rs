// Lead check for Files thumbnails (bca88b0): what happens to a decoder-upgrade recovery wave when
// this server cannot reach object storage while the wave runs, and after storage is reachable again.
// Copy to apps/server/tests/lead_outage.rs. It prints job rows; the only assertions are the setup.
// The server reaches RustFS through a local TCP relay; stopping the relay refuses new connections
// and drops open ones, which is what a stopped storage service looks like to a running server.
#[expect(dead_code, reason = "shared fixture")]
#[path = "support/media_worker.rs"]
mod media_worker;
#[path = "support/storage.rs"]
mod storage;
#[expect(dead_code, reason = "shared fixture")]
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

async fn rows(server: &TestServer, label: &str) {
    let rows = server.state.db.query_all_raw(hyori_server::db::sql(
        "SELECT i.name,j.state,j.attempts,coalesce(j.failure,'-') AS failure,j.upgrade_retry,
                CASE WHEN j.decoder_revision IS NULL THEN 'null' WHEN j.decoder_revision='older' THEN 'older' ELSE 'current' END AS decoder
         FROM hyori_media_jobs j JOIN hyori_items i ON i.object_key=j.source_key ORDER BY i.name", vec![])).await.unwrap();
    println!("LEAD {label}");
    for row in rows {
        println!(
            "LEAD   {} state={} attempts={} failure={} upgrade_retry={} decoder={}",
            row.try_get::<String>("", "name").unwrap(),
            row.try_get::<String>("", "state").unwrap(),
            row.try_get::<i32>("", "attempts").unwrap(),
            row.try_get::<String>("", "failure").unwrap(),
            row.try_get::<bool>("", "upgrade_retry").unwrap(),
            row.try_get::<String>("", "decoder").unwrap(),
        );
    }
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker"]
async fn lead_recovery_wave_during_a_storage_outage() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    let upstream = fs.config.endpoint.trim_start_matches("http://").to_owned();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut relayed = fs.config.clone();
    relayed.endpoint = format!("http://{address}");
    let running = tokio::spawn(relay(listener, upstream.clone()));
    pg.config.storage = Some(relayed);
    pg.config.media_worker_socket = Some(worker.socket.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}), None).await;
    let cookie = admin.credential();
    let png = include_bytes!("fixtures/media/red.png");
    let mut ids = vec![];
    for n in 0..6 {
        ids.push(
            upload(&server, &cookie, &format!("old-{n}.png"), png).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    // Six valid images whose derivation failed under an older decoder (three exhausted transport
    // failures, three codec rejections), as after an upgrade from a release with a faulty decoder.
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET state='failed',failure='unavailable',attempts=3,decoder_revision='older' WHERE state='queued'").await.unwrap();
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs j SET state='unsupported',failure='invalidMedia',attempts=1 FROM hyori_items i WHERE i.object_key=j.source_key AND i.name IN ('old-3.png','old-4.png','old-5.png')").await.unwrap();
    rows(&server, "before: historical failures").await;

    // Storage goes away while this server keeps running its media maintenance.
    running.abort();
    let _ = running.await;
    for pass in 0..10 {
        let result = jobs::run_once(&server.state).await;
        if pass == 0 {
            println!(
                "LEAD first maintenance pass during the outage returned ok={}",
                result.is_ok()
            );
        }
    }
    rows(
        &server,
        "after 10 maintenance passes with storage unreachable",
    )
    .await;
    assert_eq!(
        server.state.db.query_one_raw(hyori_server::db::sql(
            "SELECT count(*)::bigint AS n FROM hyori_media_jobs WHERE state='queued' AND attempts=0 AND failure='unavailable' AND upgrade_retry AND decoder_revision<>'older' AND due_at>now()",
            vec![])).await.unwrap().unwrap().try_get::<i64>("", "n").unwrap(),
        6,
        "an outage defers every upgrade retry without consuming its decoder attempt"
    );

    // Storage is reachable again at the same address: the server keeps running maintenance.
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let _running = tokio::spawn(relay(listener, upstream));
    assert!(
        {
            // Wait for the durable backoff rather than accelerating the production clock or queue.
            let delay = server.state.db.query_one_raw(hyori_server::db::sql(
            "SELECT greatest(0,ceil(extract(epoch FROM (max(due_at)-now()))*1000))::bigint AS delay FROM hyori_media_jobs",
            vec![])).await.unwrap().unwrap().try_get::<i64>("", "delay").unwrap();
            assert!(
                (1..=20_000).contains(&delay),
                "first retry is spaced by at most 20 seconds"
            );
            tokio::time::sleep(std::time::Duration::from_millis(delay as u64 + 1)).await;
            server.state.db.query_one_raw(hyori_server::db::sql(
            "SELECT count(*)::bigint AS n FROM hyori_media_jobs WHERE state='queued' AND attempts=0 AND due_at<=now()",
            vec![])).await.unwrap().unwrap().try_get::<i64>("", "n").unwrap() == 6
        },
        "all six retries become due naturally, without another decoder change"
    );
    for _ in 0..20 {
        jobs::run_once(&server.state).await.unwrap();
    }
    rows(
        &server,
        "after 20 maintenance passes with storage reachable again",
    )
    .await;
    let listing = server.rpc("files.list", json!({}), Some(&cookie)).await;
    let ready = ids
        .iter()
        .filter(|id| listing.value()["thumbnails"][id.as_str()]["url"].is_string())
        .count();
    println!(
        "LEAD thumbnails ready after recovery: {ready} of {}",
        ids.len()
    );
    assert_eq!(ready, 6);
    assert_eq!(
        server.state.db.query_one_raw(hyori_server::db::sql(
            "SELECT count(*)::bigint AS n FROM hyori_media_jobs WHERE state='ready' AND attempts=1 AND failure IS NULL AND NOT upgrade_retry",
            vec![])).await.unwrap().unwrap().try_get::<i64>("", "n").unwrap(),
        6
    );
}

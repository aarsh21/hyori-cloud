#[path = "support/storage.rs"]
mod storage;
mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use std::{
    process::Command,
    time::{Duration, Instant},
};
use support::{Postgres, TestServer};
use tokio::{io::AsyncWriteExt, net::TcpStream};

#[tokio::test]
#[ignore = "real HTTP/PostgreSQL/RustFS: one account's trickling parts cannot deny another account"]
async fn trickling_upload_parts_do_not_exhaust_another_accounts_admission() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup", json!({"email":"victim@example.test","name":"Victim","password":random_token(),"setupToken":pg.config.setup_token}), None).await;
    setup.value();
    assert!(setup.cookie.is_some());
    let victim = setup.credential();
    let password = random_token();
    let attacker = server
        .rpc(
            "admin.createUser",
            json!({"email":"attacker@example.test","name":"Ordinary user","password":password}),
            Some(&victim),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let attacker_cookie = server
        .rpc(
            "auth.login",
            json!({"email":"attacker@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let input = |name: String| json!({"parentId":null,"name":name,"size":3,"mimeType":"application/octet-stream"});
    let victim_upload = server
        .rpc("uploads.begin", input("victim.bin".into()), Some(&victim))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .rpc("uploads.status", json!({"uploadId":victim_upload}), None)
        .await
        .error(403, "access.denied");
    let mut uploads = Vec::new();
    for index in 0..16 {
        let id = server
            .rpc(
                "uploads.begin",
                input(format!("trickle-{index}.bin")),
                Some(&attacker_cookie),
            )
            .await
            .value()["uploadId"]
            .as_str()
            .unwrap()
            .to_owned();
        uploads.push(id);
    }
    let mut sockets = Vec::new();
    for id in uploads {
        let mut socket = TcpStream::connect(server.url.trim_start_matches("http://"))
            .await
            .unwrap();
        // A valid part declares three bytes, sends one, and holds the remaining body open.
        socket.write_all(format!("PUT /api/storage/uploads/{id}/1 HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {attacker_cookie}\r\nContent-Length: 3\r\n\r\nx").as_bytes()).await.unwrap();
        sockets.push(socket);
    }
    // Observe committed leases, not the private semaphore. With a per-user fix only that user's
    // allowed subset may enter; the other sockets may be rejected or wait outside global slots.
    let start = Instant::now();
    let held = loop {
        let row = server.state.db.query_one_raw(sql("SELECT count(*) AS held FROM hyori_uploads WHERE uploader_id=$1 AND lease_token IS NOT NULL", vec![attacker.clone().into()])).await.unwrap().unwrap();
        let held = row.try_get::<i64>("", "held").unwrap();
        if held == 16 || start.elapsed() >= Duration::from_secs(3) {
            break held;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(
        held > 0,
        "the attack must reach real streaming upload leases"
    );
    let during = server
        .client
        .put(format!(
            "{}/api/storage/uploads/{victim_upload}/1",
            server.url
        ))
        .header("host", "localhost:3001")
        .header("origin", &pg.config.origin)
        .header("cookie", &victim)
        .body("abc")
        .send()
        .await
        .unwrap();
    let during_status = during.status().as_u16();
    let during_body = during.text().await.unwrap();
    let begin_during = server
        .rpc(
            "uploads.begin",
            input("victim-second.bin".into()),
            Some(&victim),
        )
        .await;
    eprintln!(
        "ordinary user's trickling parts: committed_leases={held}; unrelated PUT={during_status} body={during_body}; unrelated begin={} body={}",
        begin_during.status, begin_during.body
    );
    drop(sockets);
    // A control after the attacker disconnects distinguishes exhausted slots from a bad victim
    // upload, credentials, storage configuration, or a permanently poisoned server.
    let recovered = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let reply = server
                .client
                .put(format!(
                    "{}/api/storage/uploads/{victim_upload}/1",
                    server.url
                ))
                .header("host", "localhost:3001")
                .header("origin", &pg.config.origin)
                .header("cookie", &victim)
                .body("abc")
                .send()
                .await
                .unwrap();
            if reply.status() == 200 {
                break reply;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("unrelated upload recovers after trickling sockets close");
    assert_eq!(
        recovered.json::<serde_json::Value>().await.unwrap()["value"]["size"],
        3
    );
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":victim_upload}),
            Some(&victim),
        )
        .await
        .value();
    eprintln!("after trickling sockets close: unrelated PUT=200 and completion=200");
    assert_eq!(
        during_status, 200,
        "another account's valid part must retain admission during a single-user flood"
    );
    begin_during.value();
    pg.stop();
}

#[tokio::test]
#[ignore = "real server process/PostgreSQL/RustFS: wrong storage key has actionable safe startup output"]
async fn wrong_storage_access_key_names_the_rejected_operation_at_startup() {
    let pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let wrong_key = random_token();
    let output = Command::new(env!("CARGO_BIN_EXE_hyori-server"))
        .env_clear()
        .env("APP_ENV", "development")
        .env("APP_ORIGIN", &pg.config.origin)
        .env("HYORI_DATABASE_URL", &pg.config.database_url)
        .env("HYORI_SETUP_TOKEN", &pg.config.setup_token)
        .env("HYORI_AUTH_SECRET", &pg.config.auth_secret)
        .env("HYORI_SERVER_BIND", "127.0.0.1:0")
        .env("HYORI_STORAGE_ENDPOINT", &fs.config.endpoint)
        .env("HYORI_STORAGE_REGION", &fs.config.region)
        .env("HYORI_STORAGE_BUCKET", &fs.config.bucket)
        .env("HYORI_STORAGE_ACCESS_KEY", &wrong_key)
        .env("HYORI_STORAGE_SECRET_KEY", &fs.config.secret_access_key)
        .output()
        .unwrap();
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    for secret in [
        &wrong_key,
        &fs.config.access_key_id,
        &fs.config.secret_access_key,
        &pg.config.setup_token,
        &pg.config.auth_secret,
    ] {
        assert!(
            !combined.contains(secret),
            "startup output must not disclose a credential"
        );
    }
    eprintln!(
        "wrong-storage-key startup exit={} output:\n{combined}",
        output.status
    );
    assert!(!output.status.success());
    assert!(
        combined.contains("storage bucket")
            && combined.contains("head_bucket")
            && combined.contains("Some(403)"),
        "startup must identify the rejected storage operation and status without exposing keys"
    );
    pg.stop();
}

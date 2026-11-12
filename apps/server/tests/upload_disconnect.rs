#[path = "support/upload_disconnect.rs"]
mod disconnect;
#[path = "support/storage.rs"]
mod storage;
mod support;

use disconnect::{ObservedServer, StorageGate, signal};
use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};
use support::{Postgres, TestServer};

async fn prepared() -> (
    Postgres,
    storage::RustFs,
    StorageGate,
    TestServer,
    String,
    String,
) {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let gate = StorageGate::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = gate.endpoint.clone();
    pg.config.storage = Some(config);
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup", json!({"email":"disconnect@example.test","name":"Disconnect fixture","password":random_token(),"setupToken":server.state.config.setup_token}), None).await;
    assert!(setup.cookie.is_some());
    let cookie = setup.credential();
    let owner = setup.value()["id"].as_str().unwrap().to_owned();
    (pg, fs, gate, server, cookie, owner)
}
async fn begin(server: &TestServer, cookie: &str, name: &str, replacement: Option<&str>) -> String {
    let mut input =
        json!({"parentId":null,"name":name,"size":3,"mimeType":"application/octet-stream"});
    if let Some(id) = replacement {
        input["replaceId"] = json!(id);
    }
    server
        .rpc("uploads.begin", input, Some(cookie))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn part(server: &TestServer, cookie: &str, id: &str) {
    let response = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body("abc")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
}
async fn settled(server: &TestServer, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row = server
                .state
                .db
                .query_one_raw(sql(
                    "SELECT lease_token FROM hyori_uploads WHERE id=$1",
                    vec![id.into()],
                ))
                .await
                .unwrap()
                .unwrap();
            if row
                .try_get::<Option<String>>("", "lease_token")
                .unwrap()
                .is_none()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("disconnect must not strand the three-minute operation lease");
}
async fn accounting(
    server: &TestServer,
    owner: &str,
    used: i64,
    reserved: i64,
    objects: i64,
    versions: i64,
) {
    let row = server.state.db.query_one_raw(sql("SELECT used_bytes,reserved_bytes,pending_uploads,(SELECT count(*) FROM hyori_objects WHERE owner_id=u.id) AS objects,(SELECT count(*) FROM hyori_versions WHERE owner_id=u.id) AS versions FROM hyori_users u WHERE id=$1", vec![owner.into()])).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "used_bytes").unwrap(), used);
    assert_eq!(row.try_get::<i64>("", "reserved_bytes").unwrap(), reserved);
    assert_eq!(
        row.try_get::<i32>("", "pending_uploads").unwrap(),
        if reserved == 0 { 0 } else { 1 }
    );
    assert_eq!(row.try_get::<i64>("", "objects").unwrap(), objects);
    assert_eq!(row.try_get::<i64>("", "versions").unwrap(), versions);
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS and socket disconnect after S3 completion"]
async fn disconnected_completion_reconciles_same_id_without_lease_expiry_or_duplicate_history() {
    let (_pg, fs, gate, server, cookie, owner) = prepared().await;
    let original = begin(&server, &cookie, "replacement.bin", None).await;
    part(&server, &cookie, &original).await;
    let original = server
        .rpc(
            "uploads.complete",
            json!({"uploadId":original}),
            Some(&cookie),
        )
        .await;
    let file_id = original.value()["id"].as_str().unwrap();
    let id = begin(&server, &cookie, "replacement.bin", Some(file_id)).await;
    part(&server, &cookie, &id).await;
    let observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(1, Ordering::SeqCst);
    let socket = observed
        .request(
            "POST",
            "/api/rpc",
            &cookie,
            json!({"operation":"uploads.complete","input":{"uploadId":id}})
                .to_string()
                .as_bytes(),
        )
        .await;
    signal(&gate.reached).await;
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    assert_eq!(
        hyori_storage::ObjectStorage::new(fs.config.clone())
            .unwrap()
            .head(&key)
            .await
            .unwrap()
            .size,
        3
    );
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    gate.release.notify_one();
    settled(&server, &id).await;
    let result = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(result.value()["id"], file_id);
    let replay = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(replay.value(), result.value());
    accounting(&server, &owner, 6, 0, 2, 1).await;
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS and socket disconnect after S3 part write"]
async fn disconnected_part_acknowledgement_can_retry_without_lease_expiry() {
    let (_pg, _fs, gate, server, cookie, owner) = prepared().await;
    let id = begin(&server, &cookie, "part.bin", None).await;
    let observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(2, Ordering::SeqCst);
    let socket = observed
        .request(
            "PUT",
            &format!("/api/storage/uploads/{id}/1"),
            &cookie,
            b"abc",
        )
        .await;
    signal(&gate.reached).await;
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    gate.release.notify_one();
    settled(&server, &id).await;
    part(&server, &cookie, &id).await;
    let status = server
        .rpc("uploads.status", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(status.value()["parts"].as_array().unwrap().len(), 1);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await
        .value();
    accounting(&server, &owner, 3, 0, 1, 0).await;
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS disconnected task admission and graceful drain"]
async fn disconnected_workers_retain_all_sixteen_permits_until_durable_finish_and_shutdown_drains_them()
 {
    let (pg, _fs, gate, server, cookie, owner) = prepared().await;
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"drain"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut principals = vec![cookie.clone()];
    // Eight principals, not one bypassing the new two-operation fairness bound. Still fill
    // all sixteen global slots and prove a disconnected worker retains every admission guard.
    for index in 1..8 {
        let email = format!("drain-{index}@example.test");
        let password = random_token();
        let user = server
            .rpc(
                "admin.createUser",
                json!({"email":email,"name":"Drain","password":password}),
                Some(&cookie),
            )
            .await
            .value()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        server
            .rpc(
                "shares.create",
                json!({"itemId":folder,"role":"contributor","public":false,"recipientId":user}),
                Some(&cookie),
            )
            .await
            .value();
        principals.push(
            server
                .rpc(
                    "auth.login",
                    json!({"email":email,"password":password}),
                    None,
                )
                .await
                .credential(),
        );
    }
    let mut ids = Vec::new();
    for index in 0..16 {
        let principal = &principals[index / 2];
        let id = server.rpc("uploads.begin", json!({"parentId":folder,"name":format!("bounded-{index}.bin"),"size":3,"mimeType":"application/octet-stream"}), Some(principal)).await.value()["uploadId"].as_str().unwrap().to_owned();
        part(&server, principal, &id).await;
        ids.push((id, principal.clone()));
    }
    let mut observed = ObservedServer::start(server.state.clone()).await;
    for (id, principal) in &ids {
        gate.mode.store(1, Ordering::SeqCst);
        let socket = observed
            .request(
                "POST",
                "/api/rpc",
                principal,
                json!({"operation":"uploads.complete","input":{"uploadId":id}})
                    .to_string()
                    .as_bytes(),
            )
            .await;
        signal(&gate.reached).await;
        socket.shutdown(std::net::Shutdown::Both).unwrap();
        drop(socket);
        signal(&observed.ended).await;
    }
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":ids[0].0}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    observed.stop_accepting().await;
    let state = server.state.clone();
    // Same app-owned drain that main invokes after Axum stops admission.
    let mut drain = Box::pin(state.drain_transfers());
    assert!(futures_util::poll!(&mut drain).is_pending());
    for (id, _) in &ids {
        gate.release.notify_one();
        settled(&server, id).await;
    }
    tokio::time::timeout(Duration::from_secs(5), &mut drain)
        .await
        .unwrap()
        .unwrap();
    accounting(&server, &owner, 48, 0, 16, 0).await;
    // The drain closes admission rather than allowing a new worker after shutdown.
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":ids[0].0}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS revoked public grant while disconnected completion is pending"]
async fn disconnected_completion_rechecks_revoked_grants_and_retains_exact_key_cleanup() {
    let (_pg, fs, gate, server, cookie, owner) = prepared().await;
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"shared"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"contributor","public":true}),
            Some(&cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let id = server.rpc("uploads.begin", json!({"parentId":folder,"name":"revoked.bin","size":3,"mimeType":"application/octet-stream"}), Some(&grant)).await.value()["uploadId"].as_str().unwrap().to_owned();
    part(&server, &grant, &id).await;
    let observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(1, Ordering::SeqCst);
    let socket = observed
        .request(
            "POST",
            "/api/rpc",
            &grant,
            json!({"operation":"uploads.complete","input":{"uploadId":id}})
                .to_string()
                .as_bytes(),
        )
        .await;
    signal(&gate.reached).await;
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    server
        .rpc(
            "shares.revoke",
            json!({"id":link.value()["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    gate.release.notify_one();
    settled(&server, &id).await;
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&grant))
        .await
        .error(403, "access.denied");
    accounting(&server, &owner, 0, 3, 0, 0).await;
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1 AND state='finalizing'",
            vec![id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    let direct = hyori_storage::ObjectStorage::new(fs.config.clone()).unwrap();
    assert_eq!(direct.head(&key).await.unwrap().size, 3);
    let neighbour = format!("{key}-keep");
    let keep = direct
        .begin(&neighbour, "application/octet-stream")
        .await
        .unwrap();
    server.state.db.execute_raw(sql("UPDATE hyori_uploads SET expires_at=now()-interval '1 second',cleanup_due=now() WHERE id=$1", vec![id.clone().into()])).await.unwrap();
    hyori_server::features::uploads::cleanup::reclaim(&server.state)
        .await
        .unwrap();
    assert!(direct.head(&key).await.is_err());
    assert_eq!(
        direct.unfinished(&neighbour).await.unwrap().uploads[0].upload_id,
        keep
    );
    // A late effect at the inventoried exact key remains discoverable after the first cleanup.
    direct
        .begin(&key, "application/octet-stream")
        .await
        .unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_uploads SET cleanup_due=now() WHERE id=$1",
            vec![id.into()],
        ))
        .await
        .unwrap();
    hyori_server::features::uploads::cleanup::reclaim(&server.state)
        .await
        .unwrap();
    assert!(direct.unfinished(&key).await.unwrap().uploads.is_empty());
    accounting(&server, &owner, 0, 0, 0, 0).await;
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS account deletion while disconnected completion is pending"]
async fn deleted_account_cannot_be_published_by_a_disconnected_worker() {
    let (_pg, fs, gate, server, admin, _) = prepared().await;
    let password = random_token();
    let owner = server
        .rpc(
            "admin.createUser",
            json!({"email":"deleted@example.test","name":"Disposable","password":password}),
            Some(&admin),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":"deleted@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let id = begin(&server, &cookie, "deleted.bin", None).await;
    part(&server, &cookie, &id).await;
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    let mut observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(1, Ordering::SeqCst);
    let socket = observed
        .request(
            "POST",
            "/api/rpc",
            &cookie,
            json!({"operation":"uploads.complete","input":{"uploadId":id}})
                .to_string()
                .as_bytes(),
        )
        .await;
    signal(&gate.reached).await;
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":owner,"confirmEmail":"deleted@example.test"}),
            Some(&admin),
        )
        .await
        .value();
    gate.release.notify_one();
    observed.stop_accepting().await;
    tokio::time::timeout(Duration::from_secs(5), server.state.drain_transfers())
        .await
        .unwrap()
        .unwrap();
    hyori_server::features::admin::purge::reclaim(&server.state)
        .await
        .unwrap();
    accounting(&server, &owner, 0, 0, 0, 0).await;
    let direct = hyori_storage::ObjectStorage::new(fs.config.clone()).unwrap();
    assert!(direct.head(&key).await.is_err());
    let count = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS n FROM hyori_items WHERE owner_id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "n")
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS stalled S3 response and bounded disconnected worker lifetime"]
async fn disconnected_worker_exits_on_storage_deadline_without_releasing_the_held_response() {
    let (_pg, _fs, gate, server, cookie, owner) = prepared().await;
    let id = begin(&server, &cookie, "deadline.bin", None).await;
    part(&server, &cookie, &id).await;
    let mut observed = ObservedServer::start(server.state.clone()).await;
    gate.mode.store(1, Ordering::SeqCst);
    let socket = observed
        .request(
            "POST",
            "/api/rpc",
            &cookie,
            json!({"operation":"uploads.complete","input":{"uploadId":id}})
                .to_string()
                .as_bytes(),
        )
        .await;
    signal(&gate.reached).await;
    socket.shutdown(std::net::Shutdown::Both).unwrap();
    drop(socket);
    signal(&observed.ended).await;
    observed.stop_accepting().await;
    let started = std::time::Instant::now();
    // No sleep or fake future cancellation: the real S3 read deadline drives this result.
    tokio::time::timeout(Duration::from_secs(40), server.state.drain_transfers())
        .await
        .expect("stalled S3 response must release the worker and its admission")
        .unwrap();
    eprintln!(
        "stalled completion worker drained after {:?}",
        started.elapsed()
    );
    gate.release.notify_one();
    settled(&server, &id).await;
    let status = server
        .rpc("uploads.status", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(status.value()["state"], "complete");
    accounting(&server, &owner, 3, 0, 1, 0).await;
}

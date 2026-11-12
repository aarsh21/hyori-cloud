#[path = "support/download_revision.rs"]
mod download_revision;
#[path = "support/grant_continuity.rs"]
mod grant_continuity;
#[path = "support/storage.rs"]
mod storage;
mod support;
use hyori_server::{auth::random_token, db::sql, features::uploads::cleanup};
use hyori_storage::{Bytes, ObjectStorage, PartRef};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use support::{Postgres, TestServer};

fn share_token(value: &Value) -> &str {
    value["url"].as_str().unwrap().rsplit('/').next().unwrap()
}
async fn setup(server: &TestServer) -> (String, String) {
    let reply=server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    assert!(reply.cookie.is_some());
    (
        reply.value()["id"].as_str().unwrap().into(),
        reply.credential(),
    )
}
async fn begin(
    server: &TestServer,
    cookie: &str,
    name: &str,
    size: u64,
    parent: Option<&str>,
    replace: Option<&str>,
) -> String {
    let mut input = json!({"parentId":parent,"name":name,"size":size,"mimeType":"text/html"});
    if let Some(id) = replace {
        input["replaceId"] = json!(id);
    }
    server
        .rpc("uploads.begin", input, Some(cookie))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .into()
}
async fn put(server: &TestServer, cookie: &str, id: &str, bytes: &[u8]) -> reqwest::Response {
    server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .header("content-length", bytes.len())
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap()
}
async fn complete(server: &TestServer, cookie: &str, id: &str) -> Value {
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()
        .clone()
}
async fn get(
    server: &TestServer,
    cookie: &str,
    id: &str,
    range: Option<&str>,
) -> reqwest::Response {
    let request = server
        .client
        .get(format!("{}/api/storage/files/{id}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie);
    let request = if let Some(range) = range {
        request.header("range", range)
    } else {
        request
    };
    request.send().await.unwrap()
}
async fn accounting(server: &TestServer, owner: &str) -> (i64, i64) {
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT used_bytes,reserved_bytes FROM hyori_users WHERE id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    (
        row.try_get("", "used_bytes").unwrap(),
        row.try_get("", "reserved_bytes").unwrap(),
    )
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn owner_idle_expiry_inventory_cross_session_cancel_and_pending_limit() {
    let mut pg = Postgres::start().await;
    let rustfs = storage::RustFs::start().await;
    pg.config.storage = Some(rustfs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let owner_password = random_token();
    let setup = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":owner_password,"setupToken":server.state.config.setup_token}), None).await;
    let owner = setup.value()["id"].as_str().unwrap().to_owned();
    let cookie = setup.credential();
    let abandoned = begin(&server, &cookie, "abandoned", 7, None, None).await;
    let row = server.state.db.query_one_raw(sql(
        "SELECT extract(epoch FROM expires_at-created_at)::bigint AS seconds FROM hyori_uploads WHERE id=$1",
        vec![abandoned.clone().into()],
    )).await.unwrap().unwrap();
    assert_eq!(
        row.try_get::<i64>("", "seconds").unwrap(),
        86400,
        "new owner reservations expire after 24 idle hours"
    );

    // Test-only acceleration of the per-row policy, not an operator knob or a changed clock.
    server.state.db.execute_raw(sql(
        "UPDATE hyori_uploads SET idle_seconds=2,expires_at=now()+interval '2 seconds',cleanup_due=now()+interval '2 seconds' WHERE id=$1",
        vec![abandoned.clone().into()],
    )).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    assert_eq!(
        put(&server, &cookie, &abandoned, b"1234567").await.status(),
        200
    );
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(
        accounting(&server, &owner).await,
        (0, 7),
        "activity extended the idle window"
    );
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(accounting(&server, &owner).await, (0, 0));
    server
        .rpc(
            "uploads.status",
            json!({"uploadId":abandoned}),
            Some(&cookie),
        )
        .await
        .value();

    let legacy = begin(&server, &cookie, "legacy", 3, None, None).await;
    server.state.db.execute_raw(sql("UPDATE hyori_uploads SET idle_seconds=NULL,expires_at=created_at+interval '7 days' WHERE id=$1", vec![legacy.clone().into()])).await.unwrap();
    assert_eq!(put(&server, &cookie, &legacy, b"old").await.status(), 200);
    let row = server.state.db.query_one_raw(sql("SELECT extract(epoch FROM expires_at-created_at)::bigint AS seconds FROM hyori_uploads WHERE id=$1",vec![legacy.clone().into()])).await.unwrap().unwrap();
    assert_eq!(
        row.try_get::<i64>("", "seconds").unwrap(),
        604800,
        "legacy expiry is preserved"
    );
    server
        .rpc("uploads.pending", json!({"cursor":null,"limit":1}), None)
        .await
        .error(401, "auth.required");
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":"other@example.test","name":"Other","password":password}),
            Some(&cookie),
        )
        .await
        .value();
    let other = server
        .rpc(
            "auth.login",
            json!({"email":"other@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let first = server
        .rpc(
            "uploads.pending",
            json!({"cursor":null,"limit":1}),
            Some(&other),
        )
        .await;
    assert_eq!(first.value()["items"], json!([]));
    server
        .rpc("uploads.abort", json!({"uploadId":legacy}), Some(&other))
        .await
        .error(403, "access.denied");

    // Re-authentication in another browser needs no local checkpoint to discover/cancel.
    let second_cookie = server
        .rpc(
            "auth.login",
            json!({"email":"owner@example.test","password":owner_password}),
            None,
        )
        .await
        .credential();
    let first = server
        .rpc(
            "uploads.pending",
            json!({"cursor":null,"limit":1}),
            Some(&second_cookie),
        )
        .await;
    assert_eq!(first.value()["items"][0]["uploadId"], legacy);
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":legacy}),
            Some(&second_cookie),
        )
        .await
        .value();
    assert_eq!(accounting(&server, &owner).await, (0, 0));

    // Seed disposable reservations instead of paying 128 external multipart initiations.
    for _ in 0..128 {
        let id = random_token();
        server.state.db.execute_raw(sql("INSERT INTO hyori_uploads(id,owner_id,uploader_id,initiator,name,size,mime_type,object_key,state) VALUES($1,$2,$2,$2,'pending',0,'text/plain',$3,'starting')",vec![id.clone().into(),owner.clone().into(),format!("owners/{owner}/{id}").into()])).await.unwrap();
    }
    server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"over-limit","size":0,"mimeType":""}),
            Some(&cookie),
        )
        .await
        .error(409, "uploads.limitReached");
    let page = server
        .rpc(
            "uploads.pending",
            json!({"cursor":null,"limit":100}),
            Some(&cookie),
        )
        .await;
    assert_eq!(page.value()["items"].as_array().unwrap().len(), 100);
    let next = server
        .rpc(
            "uploads.pending",
            json!({"cursor":page.value()["cursor"],"limit":100}),
            Some(&cookie),
        )
        .await;
    assert_eq!(next.value()["items"].as_array().unwrap().len(), 28);
    assert!(next.value()["cursor"].is_null());
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":page.value()["items"][0]["uploadId"]}),
            Some(&second_cookie),
        )
        .await
        .value();
    begin(&server, &cookie, "slot-released", 0, None, None).await;
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn slow_parts_cannot_exhaust_another_principals_upload_admission() {
    use tokio::io::AsyncWriteExt;
    let mut pg = Postgres::start().await;
    let rustfs = storage::RustFs::start().await;
    pg.config.storage = Some(rustfs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let (_owner, cookie) = setup(&server).await;
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":"independent@example.test","name":"Independent","password":password}),
            Some(&cookie),
        )
        .await
        .value();
    let other = server
        .rpc(
            "auth.login",
            json!({"email":"independent@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let independent = begin(&server, &other, "independent", 3, None, None).await;
    let mut ids = vec![];
    for index in 0..16 {
        ids.push(begin(&server, &cookie, &format!("slow-{index}"), 3, None, None).await);
    }
    let mut sockets = vec![];
    for id in &ids {
        let mut socket = tokio::net::TcpStream::connect(server.url.trim_start_matches("http://"))
            .await
            .unwrap();
        socket.write_all(format!("PUT /api/storage/uploads/{id}/1 HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {cookie}\r\nContent-Length: 3\r\n\r\n").as_bytes()).await.unwrap();
        sockets.push(socket);
    }
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let response = put(&server, &other, &independent, b"abc").await;
    assert_eq!(
        response.status(),
        200,
        "one account's slow bodies must leave other accounts able to write: {}",
        response.text().await.unwrap()
    );
    let active = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*)::bigint AS n FROM hyori_uploads WHERE lease_until>now()",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "n")
        .unwrap();
    assert_eq!(
        active, 2,
        "SDK queue sends two files, each with one serial part"
    );
    drop(sockets);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"public-slow"}),
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
    let mut visitors = vec![];
    for index in 0..16 {
        let grant = server
            .rpc(
                "shares.resolve",
                json!({"token":share_token(link.value())}),
                None,
            )
            .await
            .credential();
        let id = begin(
            &server,
            &grant,
            &format!("visitor-{index}"),
            3,
            Some(&folder),
            None,
        )
        .await;
        visitors.push((id, grant));
    }
    let mut sockets = vec![];
    for (id, grant) in &visitors {
        let mut socket = tokio::net::TcpStream::connect(server.url.trim_start_matches("http://"))
            .await
            .unwrap();
        socket.write_all(format!("PUT /api/storage/uploads/{id}/1 HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {grant}\r\nContent-Length: 3\r\n\r\n").as_bytes()).await.unwrap();
        sockets.push(socket);
    }
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let response = put(&server, &other, &independent, b"abc").await;
    assert_eq!(response.status(), 200);
    let active = server.state.db.query_one_raw(sql("SELECT count(*)::bigint AS n FROM hyori_uploads WHERE parent_id=$1 AND lease_until>now()",vec![folder.clone().into()])).await.unwrap().unwrap().try_get::<i64>("","n").unwrap();
    assert_eq!(
        active, 4,
        "independent visitor grants still share the public link's four slots"
    );
    // Keep their connections open: the server, not client disconnect, must release idle bodies.
    tokio::time::timeout(std::time::Duration::from_secs(35), async {
        loop {
            let active = server.state.db.query_one_raw(sql("SELECT count(*)::bigint AS n FROM hyori_uploads WHERE parent_id=$1 AND lease_until>now()",vec![folder.clone().into()])).await.unwrap().unwrap().try_get::<i64>("","n").unwrap();
            if active == 0 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }).await.expect("thirty-second body idle timeout releases leases and admission");
    assert_eq!(
        put(&server, &visitors[0].1, &visitors[0].0, b"abc")
            .await
            .status(),
        200
    );
    drop(sockets);
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn another_device_waits_for_a_part_boundary_instead_of_failing_admission() {
    use tokio::io::AsyncWriteExt;
    let mut pg = Postgres::start().await;
    let rustfs = storage::RustFs::start().await;
    pg.config.storage = Some(rustfs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let (_, cookie) = setup(&server).await;
    let mut sockets = vec![];
    for name in ["first-device-a", "first-device-b"] {
        let id = begin(&server, &cookie, name, 3, None, None).await;
        let mut socket = tokio::net::TcpStream::connect(server.url.trim_start_matches("http://"))
            .await
            .unwrap();
        socket.write_all(format!("PUT /api/storage/uploads/{id}/1 HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {cookie}\r\nContent-Length: 3\r\n\r\n").as_bytes()).await.unwrap();
        sockets.push(socket);
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let active = server
                .state
                .db
                .query_one_raw(sql(
                    "SELECT count(*)::bigint AS n FROM hyori_uploads WHERE lease_until>now()",
                    vec![],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "n")
                .unwrap();
            if active == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let waiting = {
        let (client, url, cookie) = (server.client.clone(), server.url.clone(), cookie.clone());
        tokio::spawn(async move {
            client.post(format!("{url}/api/rpc"))
                .header("host", "localhost:3001")
                .header("origin", "http://localhost:3001")
                .header("cookie", cookie)
                .json(&json!({"operation":"uploads.begin","input":{"parentId":null,"name":"second-device","size":3,"mimeType":"text/plain"}}))
                .send().await.unwrap()
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !waiting.is_finished(),
        "admission should wait for a part boundary"
    );
    sockets[0].write_all(b"abc").await.unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    let id = value["value"]["uploadId"].as_str().unwrap();
    assert_eq!(put(&server, &cookie, id, b"xyz").await.status(), 200);
    let completed = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(completed.value()["size"], 3);
    drop(sockets);
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn held_upload_lease_is_distinct_from_outage_for_part_and_completion() {
    let mut pg = Postgres::start().await;
    let rustfs = storage::RustFs::start().await;
    pg.config.storage = Some(rustfs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let (_, cookie) = setup(&server).await;
    let id = begin(&server, &cookie, "held", 3, None, None).await;
    server.state.db.execute_raw(sql("UPDATE hyori_uploads SET lease_token='another-writer',lease_until=now()+interval '3 minutes' WHERE id=$1",vec![id.clone().into()])).await.unwrap();
    server
        .rpc(
            "uploads.part",
            json!({"uploadId":id,"partNumber":1}),
            Some(&cookie),
        )
        .await
        .error(409, "uploads.busy");
    let refused = put(&server, &cookie, &id, b"abc").await;
    assert_eq!(refused.status(), 409);
    assert_eq!(
        refused.json::<Value>().await.unwrap()["error"]["code"],
        "uploads.busy"
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_uploads SET lease_until=now()-interval '1 second' WHERE id=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "uploads.part",
            json!({"uploadId":id,"partNumber":1}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(put(&server, &cookie, &id, b"abc").await.status(), 200);
    server.state.db.execute_raw(sql("UPDATE hyori_uploads SET lease_token='another-writer',lease_until=now()+interval '3 minutes' WHERE id=$1",vec![id.clone().into()])).await.unwrap();
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await
        .error(409, "uploads.busy");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_uploads SET lease_until=now()-interval '1 second' WHERE id=$1",
            vec![id.clone().into()],
        ))
        .await
        .unwrap();
    let file = complete(&server, &cookie, &id).await;
    assert_eq!(
        get(&server, &cookie, file["id"].as_str().unwrap(), None)
            .await
            .bytes()
            .await
            .unwrap(),
        b"abc"[..]
    );
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and controlled upload-table lock"]
async fn anonymous_part_authorization_is_bounded_before_the_database_pool() {
    use sea_orm::TransactionTrait;
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let (_, cookie) = setup(&server).await;
    let barrier = server.state.db.begin().await.unwrap();
    barrier
        .execute_unprepared("LOCK TABLE hyori_uploads IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..80 {
        let (client, url, origin) = (
            server.client.clone(),
            server.url.clone(),
            server.state.config.origin.clone(),
        );
        requests.spawn(async move {
            client
                .put(format!("{url}/api/storage/uploads/unknown/1"))
                .header("host", "localhost:3001")
                .header("origin", origin)
                .body("abc")
                .send()
                .await
                .unwrap()
                .status()
        });
    }
    let mut refused = 0;
    let waiting = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            while let Some(response) = requests.try_join_next() {
                assert_eq!(response.unwrap(), 409);
                refused += 1;
            }
            barrier.execute_unprepared("SELECT pg_stat_clear_snapshot()").await.unwrap();
            let waiting = barrier.query_one_raw(sql("SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%hyori_uploads%'",vec![])).await.unwrap().unwrap().try_get::<i64>("","n").unwrap();
            if waiting > 16 || (waiting == 16 && refused == 64) { break waiting; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }).await.expect("all eighty requests must reach bounded admission");
    eprintln!("anonymous part transactions waiting on upload-table lock: {waiting}");
    assert_eq!(
        waiting, 16,
        "part authorization must be bounded before entering the database"
    );
    assert_eq!(refused, 64);
    let listed = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        server.rpc("files.list", json!({"parentId":null}), Some(&cookie)),
    )
    .await
    .expect("anonymous part authorization must leave database capacity for metadata");
    listed.value();
    barrier.commit().await.unwrap();
    while let Some(response) = requests.join_next().await {
        assert!(matches!(response.unwrap().as_u16(), 404 | 409));
    }
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn upload_download_replay_versions_ranges_quota_and_shared_authority() {
    let mut pg = Postgres::start().await;
    let metadata = TestServer::start(pg.config.clone()).await;
    let (owner, cookie) = setup(&metadata).await;
    metadata
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"disabled","size":1,"mimeType":""}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    assert_eq!(get(&metadata, &cookie, "missing", None).await.status(), 503);
    drop(metadata);
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let mut server = TestServer::start(pg.config.clone()).await;
    let id = begin(&server, &cookie, "a\" é.html", 5, None, None).await;
    assert_eq!(accounting(&server, &owner).await, (0, 5));
    let missing_length = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", &cookie)
        .body(reqwest::Body::wrap_stream(futures_util::stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"hello")),
        ])))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_length.status(), 400);
    let cross_origin = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", "https://attacker.example")
        .header("cookie", &cookie)
        .body("hello")
        .send()
        .await
        .unwrap();
    assert_eq!(cross_origin.status(), 403);
    assert_eq!(put(&server, &cookie, &id, b"bad").await.status(), 400);
    assert_eq!(put(&server, &cookie, &id, b"hello").await.status(), 200);
    // A replay cannot overwrite an already acknowledged part, even with different same-size bytes.
    assert_eq!(put(&server, &cookie, &id, b"other").await.status(), 200);
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    assert_eq!(
        server
            .rpc("uploads.status", json!({"uploadId":id}), Some(&cookie))
            .await
            .value()["parts"][0]["size"],
        5
    );
    let file = complete(&server, &cookie, &id).await;
    let file_id = file["id"].as_str().unwrap();
    assert_eq!(complete(&server, &cookie, &id).await, file);
    assert_eq!(accounting(&server, &owner).await, (5, 0));
    let download = get(&server, &cookie, file_id, None).await;
    assert_eq!(download.status(), 200);
    assert_eq!(download.headers()["content-length"], "5");
    assert_eq!(
        download.headers()["content-type"],
        "application/octet-stream"
    );
    assert_eq!(download.headers()["cache-control"], "no-store");
    assert_eq!(download.headers()["x-content-type-options"], "nosniff");
    assert!(
        download.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert!(
        download.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("%22%20%C3%A9")
    );
    assert_eq!(download.bytes().await.unwrap(), "hello");
    for (range, status, expected) in [
        ("bytes=1-3", 206, "ell"),
        ("bytes=-2", 206, "lo"),
        ("bytes=2-", 206, "llo"),
        ("bytes=5-", 416, ""),
        ("bytes=0-1,3-4", 416, ""),
    ] {
        let response = get(&server, &cookie, file_id, Some(range)).await;
        assert_eq!(response.status().as_u16(), status, "{range}");
        assert_eq!(response.bytes().await.unwrap(), expected);
    }
    assert_eq!(get(&server, "", file_id, None).await.status(), 403);
    let empty = begin(&server, &cookie, "empty", 0, None, None).await;
    assert_eq!(put(&server, &cookie, &empty, b"").await.status(), 200);
    let empty_file = complete(&server, &cookie, &empty).await;
    assert_eq!(
        get(&server, &cookie, empty_file["id"].as_str().unwrap(), None)
            .await
            .bytes()
            .await
            .unwrap()
            .len(),
        0
    );
    let replacement = begin(&server, &cookie, "a\" é.html", 3, None, Some(file_id)).await;
    assert_eq!(
        put(&server, &cookie, &replacement, b"new").await.status(),
        200
    );
    complete(&server, &cookie, &replacement).await;
    assert_eq!(accounting(&server, &owner).await, (8, 0));
    let versions = server
        .rpc("files.versions", json!({"id":file_id}), Some(&cookie))
        .await;
    let version = versions.value()["items"][0]["id"].as_str().unwrap();
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":file_id,"versionId":version}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(
        get(&server, &cookie, file_id, None)
            .await
            .bytes()
            .await
            .unwrap(),
        "hello"
    );
    assert_eq!(accounting(&server, &owner).await, (8, 0));
    let stale = begin(&server, &cookie, "a\" é.html", 4, None, Some(file_id)).await;
    assert_eq!(put(&server, &cookie, &stale, b"fail").await.status(), 200);
    server
        .rpc(
            "files.rename",
            json!({"id":file_id,"name":"renamed.html"}),
            Some(&cookie),
        )
        .await
        .value();
    server
        .rpc("uploads.complete", json!({"uploadId":stale}), Some(&cookie))
        .await
        .error(409, "resource.conflict");
    assert_eq!(
        get(&server, &cookie, file_id, None)
            .await
            .bytes()
            .await
            .unwrap(),
        "hello"
    );
    // A revision conflict must not trap the initiating owner's reservation until expiry.
    server
        .rpc("uploads.abort", json!({"uploadId":stale}), Some(&cookie))
        .await
        .value();
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(accounting(&server, &owner).await, (8, 0));
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET quota_bytes=13 WHERE id=$1",
            vec![owner.clone().into()],
        ))
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        server.rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"quota-a","size":5,"mimeType":""}),
            Some(&cookie)
        ),
        server.rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"quota-b","size":5,"mimeType":""}),
            Some(&cookie)
        )
    );
    assert_eq!(
        [a.status, b.status].iter().filter(|s| **s == 200).count(),
        1
    );
    let winner = if a.status == 200 {
        a.value()["uploadId"].clone()
    } else {
        b.value()["uploadId"].clone()
    };
    for _ in 0..2 {
        server
            .rpc("uploads.abort", json!({"uploadId":winner}), Some(&cookie))
            .await
            .value();
    }
    assert_eq!(accounting(&server, &owner).await, (8, 0));
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET quota_bytes=1000 WHERE id=$1",
            vec![owner.clone().into()],
        ))
        .await
        .unwrap();
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
    let token = share_token(link.value());
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let other = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let child = server
        .rpc(
            "files.createFolder",
            json!({"parentId":folder,"name":"nested"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let shared = begin(&server, &grant, "anonymous", 2, Some(&child), None).await;
    server
        .rpc("uploads.status", json!({"uploadId":shared}), Some(&other))
        .await
        .error(403, "access.denied");
    assert_eq!(put(&server, &grant, &shared, b"ok").await.status(), 200);
    let shared_file = complete(&server, &grant, &shared).await;
    assert_eq!(shared_file["ownerId"], owner);
    assert_eq!(shared_file["access"]["canDelete"], false);
    let attribution = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT uploaded_by FROM hyori_items WHERE id=$1",
            vec![shared_file["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        attribution
            .try_get::<Option<String>>("", "uploaded_by")
            .unwrap(),
        None
    );
    let viewer = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"viewer","public":true}),
            Some(&cookie),
        )
        .await;
    let viewer_grant = server
        .rpc(
            "shares.resolve",
            json!({"token":share_token(viewer.value())}),
            None,
        )
        .await
        .credential();
    server
        .rpc(
            "uploads.begin",
            json!({"parentId":folder,"name":"denied","size":1,"mimeType":""}),
            Some(&viewer_grant),
        )
        .await
        .error(403, "access.denied");
    let password = random_token();
    let member = server
        .rpc(
            "admin.createUser",
            json!({"email":"contributor@example.test","name":"Contributor","password":password}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let member_cookie = server
        .rpc(
            "auth.login",
            json!({"email":"contributor@example.test","password":password}),
            None,
        )
        .await
        .credential();
    server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"contributor","public":false,"recipientId":member}),
            Some(&cookie),
        )
        .await
        .value();
    let attributed = begin(&server, &member_cookie, "attributed", 2, Some(&child), None).await;
    assert_eq!(
        put(&server, &member_cookie, &attributed, b"by")
            .await
            .status(),
        200
    );
    let attributed_file = complete(&server, &member_cookie, &attributed).await;
    assert_eq!(attributed_file["ownerId"], owner);
    let attribution = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT uploaded_by FROM hyori_items WHERE id=$1",
            vec![attributed_file["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        attribution.try_get::<String>("", "uploaded_by").unwrap(),
        member
    );
    let moved = begin(&server, &member_cookie, "moved", 2, Some(&child), None).await;
    server
        .rpc(
            "files.move",
            json!({"id":child,"parentId":null}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(
        put(&server, &member_cookie, &moved, b"no").await.status(),
        403
    );
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":moved}),
            Some(&member_cookie),
        )
        .await
        .value();
    server
        .rpc(
            "files.move",
            json!({"id":child,"parentId":folder}),
            Some(&cookie),
        )
        .await
        .value();
    let trashed = begin(&server, &member_cookie, "trashed", 2, Some(&child), None).await;
    server
        .rpc("files.trash", json!({"id":child}), Some(&cookie))
        .await
        .value();
    assert_eq!(
        put(&server, &member_cookie, &trashed, b"no").await.status(),
        404
    );
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":trashed}),
            Some(&member_cookie),
        )
        .await
        .value();
    server
        .rpc("files.restore", json!({"id":child}), Some(&cookie))
        .await
        .value();
    let disabled = begin(&server, &member_cookie, "disabled", 2, Some(&child), None).await;
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![member.clone().into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        put(&server, &member_cookie, &disabled, b"no")
            .await
            .status(),
        403
    );
    assert_eq!(
        get(
            &server,
            &cookie,
            attributed_file["id"].as_str().unwrap(),
            None
        )
        .await
        .bytes()
        .await
        .unwrap(),
        "by"
    );
    let revoked = begin(&server, &grant, "revoked", 2, Some(&folder), None).await;
    server
        .rpc(
            "shares.revoke",
            json!({"id":link.value()["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(put(&server, &grant, &revoked, b"no").await.status(), 403);
    assert_eq!(
        get(&server, &grant, shared_file["id"].as_str().unwrap(), None)
            .await
            .status(),
        403
    );
    drop(server);
    pg.stop();
}

struct Faults {
    mode: AtomicU8,
    reached: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
struct Proxy {
    faults: Arc<Faults>,
    endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Proxy {
    async fn start(target: String) -> Self {
        use axum::{
            Router,
            body::{Body, HttpBody},
            http::{Request, Response, StatusCode},
        };
        let faults = Arc::new(Faults {
            mode: AtomicU8::new(0),
            reached: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let state = faults.clone();
        let client = reqwest::Client::new();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let (faults, target, client) = (state.clone(), target.clone(), client.clone());
            async move {
                let (parts, body) = request.into_parts();
                let method = parts.method.clone();
                let query = parts.uri.query().unwrap_or("");
                let completing = method == "POST" && query.contains("uploadId=");
                let beginning = method == "POST" && query.contains("uploads");
                let writing = method == "PUT" && query.contains("partNumber=");
                let request = client
                    .request(method.clone(), format!("{target}{}", parts.uri))
                    .headers(parts.headers);
                let request = if body.size_hint().exact() == Some(0) {
                    request.body(Vec::new())
                } else {
                    request.body(reqwest::Body::wrap_stream(body.into_data_stream()))
                };
                let result = request.send().await.unwrap();
                let mode = faults.mode.load(Ordering::SeqCst);
                if (mode == 1 && (completing || method == "HEAD")) || (mode == 4 && beginning) {
                    // The upstream effect really happened; only its response is lost.
                    let _ = result.bytes().await.unwrap();
                    return Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .body(Body::empty())
                        .unwrap();
                }
                if (mode == 2 && writing) || (mode == 3 && completing) {
                    faults.reached.notify_one();
                    faults.release.notified().await;
                }
                let mut response = Response::builder().status(result.status());
                *response.headers_mut().unwrap() = result.headers().clone();
                response
                    .body(Body::from_stream(result.bytes_stream()))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            faults,
            endpoint,
            task,
        }
    }
}
#[tokio::test]
#[ignore = "real isolated PostgreSQL/RustFS with streamed fault-injection proxy"]
async fn ambiguous_completion_revocation_abort_fencing_and_late_exact_key_reconciliation() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let proxy = Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = proxy.endpoint.clone();
    pg.config.storage = Some(config);
    let mut server = TestServer::start(pg.config.clone()).await;
    let (owner, cookie) = setup(&server).await;
    let id = begin(&server, &cookie, "ambiguous", 4, None, None).await;
    assert_eq!(put(&server, &cookie, &id, b"data").await.status(), 200);
    proxy.faults.mode.store(1, Ordering::SeqCst);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await
        .error(503, "service.unavailable");
    assert_eq!(accounting(&server, &owner).await, (0, 4));
    proxy.faults.mode.store(0, Ordering::SeqCst);
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    let file = complete(&server, &cookie, &id).await;
    assert_eq!(
        get(&server, &cookie, file["id"].as_str().unwrap(), None)
            .await
            .bytes()
            .await
            .unwrap(),
        "data"
    );
    assert_eq!(accounting(&server, &owner).await, (4, 0));
    let raced = begin(&server, &cookie, "abort-race", 4, None, None).await;
    assert_eq!(put(&server, &cookie, &raced, b"race").await.status(), 200);
    proxy.faults.mode.store(3, Ordering::SeqCst);
    let completing = server.rpc("uploads.complete", json!({"uploadId":raced}), Some(&cookie));
    let aborting = async {
        proxy.faults.reached.notified().await;
        server
            .rpc("uploads.abort", json!({"uploadId":raced}), Some(&cookie))
            .await
            .value();
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (reply, ()) = tokio::join!(completing, aborting);
    reply.error(409, "resource.conflict");
    assert_eq!(accounting(&server, &owner).await, (4, 0));
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1",
            vec![raced.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    let direct = ObjectStorage::new(fs.config.clone()).unwrap();
    assert_eq!(direct.head(&key).await.unwrap().size, 4);
    let live_key = server
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
    direct.begin(&live_key, "text/plain").await.unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(direct.head(&live_key).await.unwrap().size, 4);
    assert!(
        direct
            .unfinished(&live_key)
            .await
            .unwrap()
            .uploads
            .is_empty()
    );
    assert!(direct.head(&key).await.is_err());
    // Late work at the durable exact key is caught by another pass; prefix neighbours survive.
    let late = direct.begin(&key, "text/plain").await.unwrap();
    let neighbour = format!("{key}-neighbour");
    let keep = direct.begin(&neighbour, "text/plain").await.unwrap();
    let etag = direct
        .part(
            &key,
            &late,
            1,
            4,
            Box::pin(futures_util::stream::iter([Ok(Bytes::from_static(
                b"late",
            ))])),
        )
        .await
        .unwrap();
    direct
        .complete(
            &key,
            &late,
            &[PartRef {
                part_number: 1,
                etag,
            }],
            4,
        )
        .await
        .unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_uploads SET cleanup_due=now() WHERE id=$1",
            vec![raced.clone().into()],
        ))
        .await
        .unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(direct.head(&key).await.is_err());
    assert_eq!(
        direct.unfinished(&neighbour).await.unwrap().uploads[0].upload_id,
        keep
    );
    // A lost begin retains its key and reservation until the bounded starting expiry sweep.
    proxy.faults.mode.store(4, Ordering::SeqCst);
    server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"lost-begin","size":3,"mimeType":"text/plain"}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    assert_eq!(accounting(&server, &owner).await, (4, 3));
    proxy.faults.mode.store(0, Ordering::SeqCst);
    server
        .state
        .db
        .execute_unprepared("UPDATE hyori_uploads SET cleanup_due=now() WHERE state='starting'")
        .await
        .unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(accounting(&server, &owner).await, (4, 0));
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"revoke"}),
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
    let grant = server
        .rpc(
            "shares.resolve",
            json!({"token":share_token(link.value())}),
            None,
        )
        .await
        .credential();
    let revoked = begin(&server, &grant, "in-flight", 4, Some(&folder), None).await;
    proxy.faults.mode.store(2, Ordering::SeqCst);
    let writing = put(&server, &grant, &revoked, b"deny");
    let revoking = async {
        proxy.faults.reached.notified().await;
        server
            .rpc(
                "shares.revoke",
                json!({"id":link.value()["id"]}),
                Some(&cookie),
            )
            .await
            .value();
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (reply, ()) = tokio::join!(writing, revoking);
    assert_eq!(reply.status(), 403);
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS n FROM hyori_upload_parts WHERE upload_id=$1",
            vec![revoked.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "n").unwrap(), 0);
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"contributor","public":true}),
            Some(&cookie),
        )
        .await;
    let grant = server
        .rpc(
            "shares.resolve",
            json!({"token":share_token(link.value())}),
            None,
        )
        .await
        .credential();
    let revoked_complete = begin(
        &server,
        &grant,
        "revoke-publication",
        4,
        Some(&folder),
        None,
    )
    .await;
    assert_eq!(
        put(&server, &grant, &revoked_complete, b"deny")
            .await
            .status(),
        200
    );
    proxy.faults.mode.store(3, Ordering::SeqCst);
    let completing = server.rpc(
        "uploads.complete",
        json!({"uploadId":revoked_complete}),
        Some(&grant),
    );
    let revoking = async {
        proxy.faults.reached.notified().await;
        server
            .rpc(
                "shares.revoke",
                json!({"id":link.value()["id"]}),
                Some(&cookie),
            )
            .await
            .value();
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (reply, ()) = tokio::join!(completing, revoking);
    reply.error(403, "access.denied");
    assert_eq!(accounting(&server, &owner).await, (4, 8));
    // A crashed cleanup owner is recoverable; due ordering moves processed records behind backlog.
    server.state.db.execute_unprepared("UPDATE hyori_uploads SET expires_at=now()-interval '1 second',cleanup_due=now(),cleanup_token='dead-worker',cleanup_until=now()-interval '1 second' WHERE state NOT IN ('complete','aborted')").await.unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(accounting(&server, &owner).await, (4, 0));
    for i in 0..12_i64 {
        let id = random_token();
        server.state.db.execute_raw(sql("INSERT INTO hyori_uploads(id,owner_id,uploader_id,name,size,mime_type,object_key,state,reservation_held,cleanup_due) VALUES ($1,$2,$2,'fair',0,'text/plain',$3,'aborted',false,now()-($4::bigint*interval '1 second'))",vec![id.clone().into(),owner.clone().into(),format!("owners/{owner}/{id}").into(),(20-i).into()])).await.unwrap();
    }
    assert_eq!(cleanup::reclaim(&server.state).await.unwrap(), 8);
    assert_eq!(cleanup::reclaim(&server.state).await.unwrap(), 4);
    drop(server);
    pg.stop();
}

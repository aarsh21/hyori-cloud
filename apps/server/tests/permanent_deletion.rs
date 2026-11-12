#[allow(dead_code)]
#[path = "support/media_worker.rs"]
mod media_worker;
#[path = "support/storage.rs"]
mod storage;
mod support;
use hyori_server::{
    auth::random_token,
    db::sql,
    features::{
        files::purge_expired_trash,
        media::{cleanup as media_cleanup, jobs},
        uploads::cleanup,
    },
};
use hyori_storage::ObjectStorage;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::time::Instant;
use support::{Postgres, TestServer};

struct Account {
    id: String,
    cookie: String,
}
async fn setup(server: &TestServer) -> Account {
    let reply = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}), None).await;
    assert!(reply.cookie.is_some());
    Account {
        id: reply.value()["id"].as_str().unwrap().into(),
        cookie: reply.credential(),
    }
}
async fn account(server: &TestServer, admin: &Account, name: &str) -> Account {
    let (email, password) = (format!("{name}@example.test"), random_token());
    let id = server
        .rpc(
            "admin.createUser",
            json!({"email":email,"name":name,"password":password}),
            Some(&admin.cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let login = server
        .rpc(
            "auth.login",
            json!({"email":email,"password":password}),
            None,
        )
        .await;
    login.value();
    Account {
        id,
        cookie: login.credential(),
    }
}
async fn folder(server: &TestServer, cookie: &str, parent: Option<&str>, name: &str) -> String {
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":parent,"name":name}),
            Some(cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
/// One public single-part upload; `replace` publishes a new version of an existing file.
async fn upload(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    replace: Option<&str>,
    name: &str,
    bytes: &[u8],
) -> String {
    upload_as(server, cookie, parent, replace, name, "text/plain", bytes).await
}
async fn upload_as(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    replace: Option<&str>,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> String {
    let mut input = json!({"parentId":parent,"name":name,"size":bytes.len(),"mimeType":mime});
    if let Some(id) = replace {
        input["replaceId"] = json!(id);
    }
    let reply = server.rpc("uploads.begin", input, Some(cookie)).await;
    let id = reply.value()["uploadId"].as_str().unwrap().to_owned();
    let put = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .header("content-length", bytes.len())
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert!(put.status().is_success(), "{}", put.status());
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn used(server: &TestServer, owner: &str) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(
            "SELECT used_bytes FROM hyori_users WHERE id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "used_bytes")
        .unwrap()
}
async fn scalar(server: &TestServer, query: &str, values: Vec<sea_orm::Value>) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(query, values))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "value")
        .unwrap()
}
async fn current_key(server: &TestServer, id: &str) -> String {
    server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_items WHERE id=$1",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "object_key")
        .unwrap()
}
async fn version_keys(server: &TestServer, file: &str) -> Vec<(String, String)> {
    server
        .state
        .db
        .query_all_raw(sql(
            "SELECT id,object_key FROM hyori_versions WHERE file_id=$1 ORDER BY created_at",
            vec![file.into()],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.try_get("", "id").unwrap(),
                row.try_get("", "object_key").unwrap(),
            )
        })
        .collect()
}
/// Drive the durable upload cleanup (the runtime's maintenance owner) until every key is gone.
async fn reclaimed(server: &TestServer, storage: &ObjectStorage, keys: &[String]) {
    for _ in 0..50 {
        cleanup::reclaim(&server.state).await.unwrap();
        let mut remaining = 0;
        for key in keys {
            remaining += usize::from(storage.head(key).await.is_ok());
        }
        if remaining == 0 {
            return;
        }
    }
    panic!("released objects were not removed from storage");
}
fn deletion(reply: &Value) -> (u64, u64) {
    (
        reply["items"].as_u64().unwrap(),
        reply["freedBytes"].as_u64().unwrap(),
    )
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS HTTP lifecycle"]
async fn permanent_deletion_frees_quota_removes_objects_and_keeps_shared_references() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let storage = ObjectStorage::new(fs.config.clone()).unwrap();
    let owner = setup(&server).await;
    let recipient = account(&server, &owner, "recipient").await;

    // Project/report.txt has two versions; Project/notes.txt one. Shared with a recipient and a link.
    let project = folder(&server, &owner.cookie, None, "Project").await;
    let report = upload(
        &server,
        &owner.cookie,
        Some(&project),
        None,
        "report.txt",
        b"first",
    )
    .await;
    upload(
        &server,
        &owner.cookie,
        Some(&project),
        Some(&report),
        "report.txt",
        b"second!",
    )
    .await;
    let notes = upload(
        &server,
        &owner.cookie,
        Some(&project),
        None,
        "notes.txt",
        b"notes",
    )
    .await;
    let loose = upload(
        &server,
        &owner.cookie,
        None,
        None,
        "loose.txt",
        b"loose-bytes",
    )
    .await;
    assert_eq!(used(&server, &owner.id).await, 5 + 7 + 5 + 11);
    let report_keys = [
        current_key(&server, &report).await,
        version_keys(&server, &report).await[0].1.clone(),
    ];
    let notes_key = current_key(&server, &notes).await;
    let loose_key = current_key(&server, &loose).await;
    server
        .rpc(
            "shares.create",
            json!({"itemId":project,"recipientId":recipient.id,"public":false,"role":"editor"}),
            Some(&owner.cookie),
        )
        .await
        .value();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":project,"role":"editor","public":true}),
            Some(&owner.cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();

    // A deduplicated reference: another item outside Trash refers to notes' immutable object.
    let alias = random_token();
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key) VALUES ($1,$2,NULL,'alias.txt','file',5,'text/plain',$3)", vec![alias.clone().into(), owner.id.clone().into(), notes_key.clone().into()])).await.unwrap();

    // Only trashed items, and only their owner.
    server
        .rpc(
            "files.deletePermanently",
            json!({"id":project}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc("files.trash", json!({"id":project}), Some(&owner.cookie))
        .await
        .value();
    for cookie in [&recipient.cookie, &grant] {
        let reply = server
            .rpc(
                "files.deletePermanently",
                json!({"id":project}),
                Some(cookie),
            )
            .await;
        reply.error(403, "access.denied");
    }
    // A recipient's Empty trash is only ever their own; a link holder has no Trash.
    let own = server
        .rpc("files.emptyTrash", json!({}), Some(&recipient.cookie))
        .await;
    assert_eq!(deletion(own.value()), (0, 0));
    server
        .rpc("files.emptyTrash", json!({}), Some(&grant))
        .await
        .error(401, "auth.required");
    let report_version = version_keys(&server, &report).await[0].0.clone();
    for cookie in [&recipient.cookie, &grant] {
        let reply = server
            .rpc(
                "files.deleteVersion",
                json!({"id":report,"versionId":report_version}),
                Some(cookie),
            )
            .await;
        assert!(reply.status == 403 || reply.status == 404, "{}", reply.body);
    }
    server
        .rpc("files.emptyTrash", json!({}), None)
        .await
        .error(401, "auth.required");
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS value FROM hyori_items WHERE id=$1 OR ancestor_ids @> jsonb_build_array($1::text)",
            vec![project.clone().into()]
        )
        .await,
        3
    );

    // Notes' bytes stay charged: the alias still refers to them.
    let summary = server
        .rpc("files.trashSummary", json!({}), Some(&owner.cookie))
        .await;
    assert_eq!(deletion(summary.value()), (1, 12));
    let deleted = server
        .rpc(
            "files.deletePermanently",
            json!({"id":project}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(deletion(deleted.value()), (3, 12));
    assert_eq!(used(&server, &owner.id).await, 5 + 11);
    assert_eq!(
        scalar(
            &server,
            "SELECT (SELECT count(*) FROM hyori_items WHERE id IN ($1,$2,$3)) + (SELECT count(*) FROM hyori_versions WHERE file_id=$2) + (SELECT count(*) FROM hyori_shares WHERE item_id=$1) AS value",
            vec![project.clone().into(), report.clone().into(), notes.clone().into()]
        )
        .await,
        0
    );
    // The link went with the folder: its grant no longer carries any authority.
    server
        .rpc("files.list", json!({"parentId":project}), Some(&grant))
        .await
        .error(401, "auth.required");
    server
        .rpc("files.restore", json!({"id":project}), Some(&owner.cookie))
        .await
        .error(404, "resource.notFound");
    reclaimed(&server, &storage, &report_keys).await;
    assert!(storage.head(&notes_key).await.is_ok());
    assert!(storage.head(&loose_key).await.is_ok());
    // Removal recorded once: a later cleanup pass never charges the owner back twice.
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(used(&server, &owner.id).await, 5 + 11);

    // Delete version: an old version alone is released; one matching live contents frees nothing.
    upload(
        &server,
        &owner.cookie,
        None,
        Some(&loose),
        "loose.txt",
        b"loose-two",
    )
    .await;
    upload(
        &server,
        &owner.cookie,
        None,
        Some(&loose),
        "loose.txt",
        b"loose-3",
    )
    .await;
    assert_eq!(used(&server, &owner.id).await, 5 + 11 + 9 + 7);
    let versions = version_keys(&server, &loose).await;
    let restored = server
        .rpc(
            "files.restoreVersion",
            json!({"id":loose,"versionId":versions[1].0}),
            Some(&owner.cookie),
        )
        .await;
    restored.value();
    let live = server
        .rpc(
            "files.deleteVersion",
            json!({"id":loose,"versionId":versions[1].0}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(deletion(live.value()), (1, 0));
    let oldest = server
        .rpc(
            "files.deleteVersion",
            json!({"id":loose,"versionId":versions[0].0}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(deletion(oldest.value()), (1, 11));
    assert_eq!(used(&server, &owner.id).await, 5 + 9 + 7);
    server
        .rpc(
            "files.deleteVersion",
            json!({"id":loose,"versionId":versions[0].0}),
            Some(&owner.cookie),
        )
        .await
        .error(404, "resource.notFound");
    reclaimed(&server, &storage, std::slice::from_ref(&loose_key)).await;
    assert!(storage.head(&versions[1].1).await.is_ok());

    // Retention: maintenance purges only trash older than the configured period (default 30 days).
    let stale = upload(&server, &owner.cookie, None, None, "stale.txt", b"stale").await;
    let recent = upload(&server, &owner.cookie, None, None, "recent.txt", b"new").await;
    let stale_key = current_key(&server, &stale).await;
    for id in [&stale, &recent] {
        server
            .rpc("files.trash", json!({"id":id}), Some(&owner.cookie))
            .await
            .value();
    }
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_items SET trashed_at=now()-interval '31 days' WHERE id=$1",
            vec![stale.clone().into()],
        ))
        .await
        .unwrap();
    assert_eq!(purge_expired_trash(&server.state).await.unwrap(), 1);
    assert_eq!(purge_expired_trash(&server.state).await.unwrap(), 0);
    assert_eq!(used(&server, &owner.id).await, 5 + 9 + 7 + 3);
    reclaimed(&server, &storage, std::slice::from_ref(&stale_key)).await;

    // Empty trash takes every root, including one nested inside another and the alias.
    let archive = folder(&server, &owner.cookie, None, "Archive").await;
    let inner = upload(
        &server,
        &owner.cookie,
        Some(&archive),
        None,
        "inner.txt",
        b"in",
    )
    .await;
    let inner_key = current_key(&server, &inner).await;
    server
        .rpc("files.trash", json!({"id":inner}), Some(&owner.cookie))
        .await
        .value();
    for id in [&archive, &alias] {
        server
            .rpc("files.trash", json!({"id":id}), Some(&owner.cookie))
            .await
            .value();
    }
    let summary = server
        .rpc("files.trashSummary", json!({}), Some(&owner.cookie))
        .await;
    assert_eq!(deletion(summary.value()), (4, 5 + 2 + 3));
    let emptied = server
        .rpc("files.emptyTrash", json!({}), Some(&owner.cookie))
        .await;
    assert_eq!(deletion(emptied.value()), (4, 5 + 2 + 3));
    assert_eq!(used(&server, &owner.id).await, 9 + 7);
    let trash = server
        .rpc("files.list", json!({"view":"trash"}), Some(&owner.cookie))
        .await;
    assert_eq!(trash.value()["items"], json!([]));
    reclaimed(&server, &storage, &[notes_key, inner_key]).await;
    assert_eq!(
        server
            .rpc("files.trashSummary", json!({}), Some(&owner.cookie))
            .await
            .value(),
        &json!({"items":0,"freedBytes":0})
    );
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL; metadata only, no RustFS"]
async fn twenty_thousand_item_subtree_trashes_restores_moves_and_deletes_atomically() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = setup(&server).await;
    let big = folder(&server, &owner.cookie, None, "Big").await;
    let destination = folder(&server, &owner.cookie, None, "Destination").await;
    // 200 folders of 99 files each: 20,000 descendants.
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids) SELECT 'big-'||n,$1,$2,'folder-'||n,'folder','inode/directory',jsonb_build_array($2::text) FROM generate_series(1,200) n", vec![owner.id.clone().into(), big.clone().into()])).await.unwrap();
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key,ancestor_ids) SELECT 'big-'||f||'-'||n,$1,'big-'||f,'file-'||n,'file',1,'text/plain','fixture/big/'||f||'/'||n,jsonb_build_array($2::text,'big-'||f) FROM generate_series(1,200) f, generate_series(1,99) n", vec![owner.id.clone().into(), big.clone().into()])).await.unwrap();
    server
        .state
        .db
        .execute_unprepared("ANALYZE hyori_items")
        .await
        .unwrap();
    let count = |predicate: &'static str| {
        let big = big.clone();
        let server = &server;
        async move {
            scalar(
                server,
                &format!("SELECT count(*) AS value FROM hyori_items WHERE ancestor_ids @> jsonb_build_array($1::text) AND {predicate}"),
                vec![big.into()],
            )
            .await
        }
    };
    assert_eq!(count("true").await, 20_000);
    let mut timings = vec![];
    for (operation, input) in [
        ("files.trash", json!({"id":big})),
        ("files.restore", json!({"id":big})),
        ("files.move", json!({"id":big,"parentId":destination})),
        ("files.trash", json!({"id":big})),
        ("files.trashSummary", json!({})),
        ("files.deletePermanently", json!({"id":big})),
    ] {
        let started = Instant::now();
        let reply = server.rpc(operation, input, Some(&owner.cookie)).await;
        let elapsed = started.elapsed();
        assert_eq!(reply.status, 200, "{operation}: {}", reply.body);
        timings.push((operation, elapsed));
        match operation {
            "files.trash" => assert_eq!(count("trashed_at IS NOT NULL").await, 20_000),
            "files.restore" => assert_eq!(count("trashed_at IS NULL").await, 20_000),
            "files.move" => assert_eq!(
                scalar(
                    &server,
                    "SELECT count(*) AS value FROM hyori_items WHERE ancestor_ids->>0=$1 AND ancestor_ids->>1=$2",
                    vec![destination.clone().into(), big.clone().into()],
                )
                .await,
                20_000
            ),
            "files.trashSummary" => assert_eq!(reply.value()["items"], 1),
            _ => assert_eq!(reply.value()["items"], 20_001),
        }
    }
    assert_eq!(count("true").await, 0);
    for (operation, elapsed) in timings {
        eprintln!("20,000-descendant {operation}: {} ms", elapsed.as_millis());
    }
    drop(server);
    pg.stop();
}

const RED_PNG: &[u8] = include_bytes!("fixtures/media/red.png");

/// The real worker, so publication enqueues thumbnails as it does in production.
async fn media_stack() -> (
    Postgres,
    storage::RustFs,
    media_worker::Worker,
    TestServer,
    ObjectStorage,
) {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    pg.config.storage = Some(fs.config.clone());
    pg.config.media_worker_socket = Some(worker.socket.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let storage = ObjectStorage::new(fs.config.clone()).unwrap();
    (pg, fs, worker, server, storage)
}
async fn photo(server: &TestServer, owner: &Account, name: &str) -> (String, String) {
    let id = upload_as(
        server,
        &owner.cookie,
        None,
        None,
        name,
        "image/png",
        RED_PNG,
    )
    .await;
    let key = current_key(server, &id).await;
    (id, key)
}
/// Another item refers to the same object, as deduplication would.
async fn alias(server: &TestServer, owner: &Account, key: &str) {
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key) VALUES ($1,$2,NULL,'alias.png','file',$3,'image/png',$4)", vec![random_token().into(), owner.id.clone().into(), (RED_PNG.len() as i64).into(), key.into()])).await.unwrap();
}
async fn delete(server: &TestServer, owner: &Account, id: &str) {
    for operation in ["files.trash", "files.deletePermanently"] {
        server
            .rpc(operation, json!({"id":id}), Some(&owner.cookie))
            .await
            .value();
    }
}
async fn job(server: &TestServer, key: &str) -> Option<String> {
    server
        .state
        .db
        .query_one_raw(sql(
            "SELECT state FROM hyori_media_jobs WHERE source_key=$1",
            vec![key.into()],
        ))
        .await
        .unwrap()
        .map(|row| row.try_get("", "state").unwrap())
}
async fn thumbnail_key(server: &TestServer, key: &str) -> String {
    server.state.db.query_one_raw(sql("SELECT a.object_key FROM hyori_media_artifacts a JOIN hyori_media_jobs j ON j.artifact_id=a.id WHERE j.source_key=$1", vec![key.into()])).await.unwrap().unwrap().try_get("", "object_key").unwrap()
}
/// Three runtime maintenance passes, with every cleanup due as if its back-off had elapsed.
async fn maintain(server: &TestServer) {
    for _ in 0..3 {
        server
            .state
            .db
            .execute_unprepared(
                "UPDATE hyori_media_artifacts SET cleanup_due=now(); UPDATE hyori_uploads SET cleanup_due=now()",
            )
            .await
            .unwrap();
        media_cleanup::reclaim(&server.state).await.unwrap();
        jobs::run_once(&server.state).await.unwrap();
        cleanup::reclaim(&server.state).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL, pinned RustFS and the isolated media worker"]
async fn a_thumbnail_still_queued_never_keeps_a_deleted_original() {
    let (pg, _fs, _worker, server, storage) = media_stack().await;
    let owner = setup(&server).await;
    let (gone, gone_key) = photo(&server, &owner, "gone.png").await;
    let (kept, kept_key) = photo(&server, &owner, "kept.png").await;
    alias(&server, &owner, &kept_key).await;
    assert_eq!(job(&server, &gone_key).await.as_deref(), Some("queued"));

    // Deleted before any worker claimed its thumbnail.
    delete(&server, &owner, &gone).await;
    delete(&server, &owner, &kept).await;
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    maintain(&server).await;
    assert!(
        storage.head(&gone_key).await.is_err(),
        "the deleted original stayed in storage, job {:?}",
        job(&server, &gone_key).await
    );
    assert_eq!(job(&server, &gone_key).await, None);
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    // Control: an object another item still uses keeps its bytes and its thumbnail.
    assert!(storage.head(&kept_key).await.is_ok());
    assert_eq!(job(&server, &kept_key).await.as_deref(), Some("ready"));
    assert!(
        storage
            .head(&thumbnail_key(&server, &kept_key).await)
            .await
            .is_ok()
    );

    // A worker holding a lease may still be reading the original: it stays until the lease ends.
    let (busy, busy_key) = photo(&server, &owner, "busy.png").await;
    server.state.db.execute_raw(sql("UPDATE hyori_media_jobs SET state='processing',attempts=1,lease_token='held',lease_until=now()+interval '5 minutes' WHERE source_key=$1", vec![busy_key.clone().into()])).await.unwrap();
    delete(&server, &owner, &busy).await;
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    maintain(&server).await;
    assert!(
        storage.head(&busy_key).await.is_ok(),
        "reclaimed under a live lease"
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_media_jobs SET lease_until=now()-interval '1 second' WHERE source_key=$1",
            vec![busy_key.clone().into()],
        ))
        .await
        .unwrap();
    maintain(&server).await;
    assert!(
        storage.head(&busy_key).await.is_err(),
        "kept after the lease ended"
    );
    assert_eq!(job(&server, &busy_key).await, None);
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);

    // Trashed before its first attempt, the job waits; restoring it makes the thumbnail due again.
    let (back, back_key) = photo(&server, &owner, "back.png").await;
    server
        .rpc("files.trash", json!({"id":back}), Some(&owner.cookie))
        .await
        .value();
    maintain(&server).await;
    assert_eq!(job(&server, &back_key).await.as_deref(), Some("queued"));
    server
        .rpc("files.restore", json!({"id":back}), Some(&owner.cookie))
        .await
        .value();
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(job(&server, &back_key).await.as_deref(), Some("ready"));

    // The same after a failed attempt whose back-off has passed; one still backing off keeps it.
    let (again, again_key) = photo(&server, &owner, "again.png").await;
    let (waiting, waiting_key) = photo(&server, &owner, "waiting.png").await;
    server.state.db.execute_raw(sql("UPDATE hyori_media_jobs SET attempts=1,due_at=CASE WHEN source_key=$1 THEN now()-interval '1 second' ELSE now()+interval '15 seconds' END WHERE source_key IN ($1,$2)", vec![again_key.clone().into(), waiting_key.clone().into()])).await.unwrap();
    for id in [&again, &waiting] {
        server
            .rpc("files.trash", json!({"id":id}), Some(&owner.cookie))
            .await
            .value();
    }
    jobs::run_once(&server.state).await.unwrap();
    for id in [&again, &waiting] {
        server
            .rpc("files.restore", json!({"id":id}), Some(&owner.cookie))
            .await
            .value();
    }
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(job(&server, &again_key).await.as_deref(), Some("ready"));
    assert_eq!(scalar(&server, "SELECT (due_at>now()+interval '10 seconds')::int::bigint AS value FROM hyori_media_jobs WHERE source_key=$1", vec![waiting_key.clone().into()]).await, 1, "failure back-off was shortened");
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL, pinned RustFS and the isolated media worker"]
async fn an_expired_lease_never_keeps_a_deleted_original() {
    let (pg, _fs, _worker, server, storage) = media_stack().await;
    let owner = setup(&server).await;
    let lease = |attempts: i64, key: &str| {
        sql(
            "UPDATE hyori_media_jobs SET state='processing',attempts=$2,lease_token='crashed',lease_until=now()+interval '5 minutes' WHERE source_key=$1",
            vec![key.into(), attempts.into()],
        )
    };
    let expire = |key: &str| {
        sql(
            "UPDATE hyori_media_jobs SET lease_until=now()-interval '1 second' WHERE source_key=$1",
            vec![key.into()],
        )
    };
    // A sixth attempt, admitted by explicit retries, whose worker crashed mid-read.
    let (last, last_key) = photo(&server, &owner, "last.png").await;
    server
        .state
        .db
        .execute_raw(lease(6, &last_key))
        .await
        .unwrap();
    delete(&server, &owner, &last).await;
    server
        .state
        .db
        .execute_raw(expire(&last_key))
        .await
        .unwrap();
    maintain(&server).await;
    assert!(
        storage.head(&last_key).await.is_err(),
        "kept by a sixth attempt, job {:?}",
        job(&server, &last_key).await
    );
    assert_eq!(job(&server, &last_key).await, None);

    // The server restarts without a decoder after a worker crashed; deletion still completes.
    let (crash, crash_key) = photo(&server, &owner, "crash.png").await;
    let (_live, live_key) = photo(&server, &owner, "live.png").await;
    for key in [&crash_key, &live_key] {
        server.state.db.execute_raw(lease(1, key)).await.unwrap();
    }
    delete(&server, &owner, &crash).await;
    for key in [&crash_key, &live_key] {
        server.state.db.execute_raw(expire(key)).await.unwrap();
    }
    let mut config = pg.config.clone();
    config.media_worker_socket = None;
    let plain = TestServer::start(config).await;
    for _ in 0..3 {
        plain
            .state
            .db
            .execute_unprepared("UPDATE hyori_uploads SET cleanup_due=now()")
            .await
            .unwrap();
        jobs::run_once(&plain.state).await.unwrap();
        cleanup::reclaim(&plain.state).await.unwrap();
    }
    assert!(
        storage.head(&crash_key).await.is_err(),
        "kept without a decoder, job {:?}",
        job(&server, &crash_key).await
    );
    assert_eq!(job(&server, &crash_key).await, None);
    // Control: a crashed job whose photo still exists goes back to the queue for a decoder.
    assert_eq!(job(&server, &live_key).await.as_deref(), Some("queued"));
    assert!(storage.head(&live_key).await.is_ok());
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    drop(plain);
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL, pinned RustFS and the isolated media worker"]
async fn a_ready_thumbnail_goes_with_its_deleted_original() {
    let (pg, _fs, _worker, server, storage) = media_stack().await;
    let owner = setup(&server).await;
    let (gone, gone_key) = photo(&server, &owner, "gone.png").await;
    let (kept, kept_key) = photo(&server, &owner, "kept.png").await;
    alias(&server, &owner, &kept_key).await;
    for _ in 0..2 {
        assert!(jobs::run_once(&server.state).await.unwrap());
    }
    let (gone_thumb, kept_thumb) = (
        thumbnail_key(&server, &gone_key).await,
        thumbnail_key(&server, &kept_key).await,
    );
    // The first verification pass sees both thumbnails clean.
    media_cleanup::reclaim(&server.state).await.unwrap();
    assert!(storage.head(&gone_thumb).await.is_ok());

    delete(&server, &owner, &gone).await;
    delete(&server, &owner, &kept).await;
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    maintain(&server).await;
    assert!(storage.head(&gone_key).await.is_err());
    assert!(
        storage.head(&gone_thumb).await.is_err(),
        "the deleted original's thumbnail stayed in storage"
    );
    assert_eq!(job(&server, &gone_key).await, None);
    assert_eq!(used(&server, &owner.id).await, RED_PNG.len() as i64);
    // Control: a thumbnail whose source another item still uses stays, verified and ready.
    assert!(storage.head(&kept_key).await.is_ok());
    assert!(storage.head(&kept_thumb).await.is_ok());
    assert_eq!(job(&server, &kept_key).await.as_deref(), Some("ready"));
    drop(server);
    pg.stop();
}

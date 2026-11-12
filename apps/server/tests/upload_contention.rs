#[path = "support/storage.rs"]
mod storage;
mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;
use support::{Postgres, TestServer};

async fn upload_batch(server: &TestServer, cookie: &str, prefix: &str) -> Vec<String> {
    let mut failures = vec![];
    for index in 0..12 {
        let begun = server.rpc("uploads.begin", json!({"parentId":null,"name":format!("{prefix}-{index}.bin"),"size":3,"mimeType":"application/octet-stream"}), Some(cookie)).await;
        if begun.status != 200 {
            failures.push(format!("begin: {} {}", begun.status, begun.body));
            continue;
        }
        let id = begun.value()["uploadId"].as_str().unwrap();
        let part = server
            .client
            .put(format!("{}/api/storage/uploads/{id}/1", server.url))
            .header("host", "localhost:3001")
            .header("origin", &server.state.config.origin)
            .header("cookie", cookie)
            .header("content-length", 3)
            .body("abc")
            .send()
            .await
            .unwrap();
        if part.status() != 200 {
            failures.push(format!(
                "part: {} {}",
                part.status(),
                part.text().await.unwrap()
            ));
            continue;
        }
        let completed = server
            .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
            .await;
        if completed.status != 200 {
            failures.push(format!("complete: {} {}", completed.status, completed.body));
        }
    }
    failures
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and pinned RustFS same-owner concurrency"]
async fn concurrent_same_owner_uploads_do_not_upgrade_deadlock_or_report_false_conflicts() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("hyori_server=debug")
        .with_test_writer()
        .try_init();
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    assert!(setup.cookie.is_some());
    let owner = setup.value()["id"].as_str().unwrap();
    let cookie = setup.credential();
    server
        .rpc(
            "uploads.status",
            json!({"uploadId":"missing"}),
            Some(&cookie),
        )
        .await
        .error(404, "resource.notFound");
    let before = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "deadlocks")
        .unwrap();
    let (left, right) = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        tokio::join!(
            upload_batch(&server, &cookie, "left"),
            upload_batch(&server, &cookie, "right")
        )
    })
    .await
    .expect("bounded two-client upload workload");
    // Statistics are committed observations from this dedicated fixture database, not inferred timings.
    server
        .state
        .db
        .execute_unprepared("SELECT pg_stat_clear_snapshot()")
        .await
        .unwrap();
    let after = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "deadlocks")
        .unwrap();
    eprintln!(
        "same-owner upload deadlocks: {}; request failures: {:?} {:?}",
        after - before,
        left,
        right
    );
    assert!(
        left.is_empty() && right.is_empty(),
        "unexpected upload errors: {left:?} {right:?}"
    );
    assert_eq!(
        after - before,
        0,
        "ordinary concurrency must not cause account row lock-upgrade deadlocks"
    );
    let totals = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT used_bytes,reserved_bytes FROM hyori_users WHERE id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(totals.try_get::<i64>("", "used_bytes").unwrap(), 72);
    assert_eq!(totals.try_get::<i64>("", "reserved_bytes").unwrap(), 0);
    drop(server);
    pg.stop();
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and RustFS publication rollback and immediate retry"]
async fn failed_final_transaction_releases_only_its_lease_and_can_reconcile_immediately() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    let owner = setup.value()["id"].as_str().unwrap();
    let cookie = setup.credential();
    let begun = server.rpc("uploads.begin",json!({"parentId":null,"name":"forced-final-rollback.bin","size":3,"mimeType":"application/octet-stream"}),Some(&cookie)).await;
    let id = begun.value()["uploadId"].as_str().unwrap();
    let part = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", &cookie)
        .header("content-length", 3)
        .body("abc")
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 200);
    // Only this fresh fixture database is modified; force all DB-only publication retries to fail.
    server.state.db.execute_unprepared("CREATE FUNCTION reject_test_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE SQLSTATE '40001' USING MESSAGE='synthetic publication rollback'; END $$; CREATE TRIGGER reject_test_publication BEFORE INSERT ON hyori_items FOR EACH ROW WHEN (NEW.name='forced-final-rollback.bin') EXECUTE FUNCTION reject_test_publication()").await.unwrap();
    let failed = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await;
    let state = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT state,lease_token FROM hyori_uploads WHERE id=$1",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.try_get::<String>("", "state").unwrap(), "finalizing");
    assert!(
        state
            .try_get::<Option<String>>("", "lease_token")
            .unwrap()
            .is_none(),
        "rolled-back publication must not strand its operation lease: {}",
        failed.body
    );
    failed.error(503, "service.unavailable");
    server.state.db.execute_unprepared("DROP TRIGGER reject_test_publication ON hyori_items; DROP FUNCTION reject_test_publication()").await.unwrap();
    let resumed = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        server.rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie)),
    )
    .await
    .expect("retry must not wait for the three-minute lease");
    let file = resumed.value();
    let replay = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await;
    assert_eq!(replay.value(), file);
    let totals = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT used_bytes,reserved_bytes FROM hyori_users WHERE id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(totals.try_get::<i64>("", "used_bytes").unwrap(), 3);
    assert_eq!(totals.try_get::<i64>("", "reserved_bytes").unwrap(), 0);
    let objects = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS count FROM hyori_objects WHERE owner_id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(objects.try_get::<i64>("", "count").unwrap(), 1);
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL and RustFS bounded upload admission projection"]
async fn zero_byte_reservations_keep_the_admission_cap_and_rollback_with_inventory() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    let owner = setup.value()["id"].as_str().unwrap();
    let cookie = setup.credential();
    let prefix = random_token();
    // No storage is begun for these synthetic zero-byte reservation fixtures.
    server.state.db.execute_raw(sql("INSERT INTO hyori_uploads(id,owner_id,uploader_id,name,size,mime_type,object_key,state) SELECT $2||'-'||n::text,$1,$1,'slot-'||n::text,0,'application/octet-stream','owners/'||$1||'/'||$2||'-'||n::text,'starting' FROM generate_series(1,128) AS n",vec![owner.into(),prefix.clone().into()])).await.unwrap();
    // Reconstruct the prior schema only in this disposable database, retaining every upload.
    server.state.db.execute_unprepared("DROP TRIGGER hyori_upload_admission ON hyori_uploads; DROP FUNCTION hyori_track_upload_admission(); ALTER TABLE hyori_users DROP COLUMN pending_uploads; DELETE FROM hyori_migrations WHERE version=7").await.unwrap();
    hyori_server::db::migrate(&server.state.db).await.unwrap();
    let inventory = || async {
        server.state.db.query_one_raw(sql("SELECT pending_uploads,reserved_bytes,(SELECT count(*) FROM hyori_uploads WHERE owner_id=u.id AND reservation_held) AS actual FROM hyori_users u WHERE id=$1",vec![owner.into()])).await.unwrap().unwrap()
    };
    let full = inventory().await;
    assert_eq!(full.try_get::<i32>("", "pending_uploads").unwrap(), 128);
    assert_eq!(full.try_get::<i64>("", "actual").unwrap(), 128);
    assert_eq!(full.try_get::<i64>("", "reserved_bytes").unwrap(), 0);
    server.rpc("uploads.begin",json!({"parentId":null,"name":"one-too-many.bin","size":0,"mimeType":"application/octet-stream"}),Some(&cookie)).await.error(409,"uploads.limitReached");
    let first = format!("{prefix}-1");
    for _ in 0..2 {
        server
            .rpc("uploads.abort", json!({"uploadId":first}), Some(&cookie))
            .await
            .value();
    }
    assert_eq!(
        inventory()
            .await
            .try_get::<i32>("", "pending_uploads")
            .unwrap(),
        127
    );
    let tx = server.state.db.begin().await.unwrap();
    tx.execute_raw(sql(
        "UPDATE hyori_uploads SET state='aborted',reservation_held=false WHERE id=$1",
        vec![format!("{prefix}-2").into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        tx.query_one_raw(sql(
            "SELECT pending_uploads FROM hyori_users WHERE id=$1",
            vec![owner.into()]
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i32>("", "pending_uploads")
        .unwrap(),
        126
    );
    tx.rollback().await.unwrap();
    assert_eq!(
        inventory()
            .await
            .try_get::<i32>("", "pending_uploads")
            .unwrap(),
        127
    );
    let admitted = server.rpc("uploads.begin",json!({"parentId":null,"name":"fits-again.bin","size":0,"mimeType":"application/octet-stream"}),Some(&cookie)).await;
    assert!(admitted.value()["uploadId"].is_string());
    let after = inventory().await;
    assert_eq!(after.try_get::<i32>("", "pending_uploads").unwrap(), 128);
    assert_eq!(after.try_get::<i64>("", "actual").unwrap(), 128);
}

#[tokio::test]
#[ignore = "real isolated PostgreSQL account deletion lock fence"]
async fn account_key_share_allows_accounting_but_still_fences_explicit_deletion_lock() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    let owner = setup.value()["id"].as_str().unwrap();
    let reader = server.state.db.begin().await.unwrap();
    reader
        .query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 FOR KEY SHARE",
            vec![owner.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let accounting = server.state.db.begin().await.unwrap();
    accounting
        .query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 FOR NO KEY UPDATE NOWAIT",
            vec![owner.into()],
        ))
        .await
        .expect("quota locking must coexist with the authority fence")
        .unwrap();
    accounting.rollback().await.unwrap();
    let deleting = server.state.db.begin().await.unwrap();
    let blocked = deleting
        .query_one_raw(sql(
            "SELECT id FROM hyori_users WHERE id=$1 FOR UPDATE NOWAIT",
            vec![owner.into()],
        ))
        .await;
    assert!(
        blocked.is_err(),
        "account deletion must wait for current authorization holders"
    );
    deleting.rollback().await.unwrap();
    reader.rollback().await.unwrap();
}

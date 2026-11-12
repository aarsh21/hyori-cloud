use super::{
    PDF, PDF_EDIT, TestServer, enable, finish, input, open, prepare, put, scalar, setup, upload,
};
use hyori_server::{db::sql, features::uploads::cleanup};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tracing::instrument::WithSubscriber;
use tracing_subscriber::layer::SubscriberExt;

struct TransactionRetryCounter(Arc<AtomicUsize>);
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for TransactionRetryCounter {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        if event.metadata().target() == "hyori_server::db" {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(super) async fn save(
    server: &TestServer,
    cookie: &str,
    document: &mut Value,
    id: &str,
    automatic: bool,
) -> (String, Value) {
    let mut request = input(document, id, PDF_EDIT);
    if automatic {
        request["saveMode"] = json!("automatic");
    }
    let upload = prepare(server, cookie, request.clone()).await;
    assert_eq!(put(server, cookie, &upload, PDF_EDIT).await.status(), 200);
    let result = finish(server, cookie, document, id).await;
    document["revision"] = result["revision"].clone();
    (upload, request)
}
async fn history_count(server: &TestServer, file: &Value) -> i64 {
    scalar(
        server,
        "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
        file["id"].as_str().unwrap(),
    )
    .await
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS cleanup transaction contention"]
async fn automatic_cleanup_batch_does_not_compete_with_its_own_quota_acknowledgements() {
    let (_pg, _fs, server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "cleanup-batch.pdf", PDF, None).await;
    let mut document = open(&server, &cookie, &file).await;
    for index in 0..9 {
        save(
            &server,
            &cookie,
            &mut document,
            &format!("batch:{index}"),
            true,
        )
        .await;
    }
    // Select exactly eight superseded keys, with no other database writer in this fixture.
    server.state.db.execute_raw(sql(
        "UPDATE hyori_uploads SET cleanup_due=now()+interval '1 day' WHERE NOT editor_superseded",
        vec![],
    )).await.unwrap();
    let before = scalar(
        &server,
        "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
        &owner,
    )
    .await;
    let retries = Arc::new(AtomicUsize::new(0));
    let subscriber =
        tracing_subscriber::Registry::default().with(TransactionRetryCounter(retries.clone()));
    let result = cleanup::reclaim(&server.state)
        .with_subscriber(subscriber)
        .await;
    assert_eq!(
        retries.load(Ordering::Relaxed),
        0,
        "one cleanup batch retried against itself: {result:?}"
    );
    assert_eq!(result.unwrap(), 8);
    let after = scalar(
        &server,
        "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
        &owner,
    )
    .await;
    assert_eq!(before - after, 8 * PDF_EDIT.len() as i64);
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS protected outcome and expiry metadata bounds"]
async fn ineligible_completed_outcomes_fail_admission_at_total_bound_and_expire_in_one_batch() {
    let (pg, _fs, server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "copies.pdf", PDF, None).await;
    let document = open(&server, &cookie, &file).await;
    let session = document["sessionId"].as_str().unwrap().to_owned();
    for index in 0..129 {
        let id = format!("copy:{index}");
        let mut request = input(&document, &id, PDF_EDIT);
        request["intent"] = json!("save-as");
        request["destination"] = json!({"parentId":null});
        request["name"] = json!(format!("copy-{index}.pdf"));
        let upload = prepare(&server, &cookie, request).await;
        assert_eq!(put(&server, &cookie, &upload, PDF_EDIT).await.status(), 200);
        assert_eq!(
            finish(&server, &cookie, &document, &id).await["revision"],
            document["revision"]
        );
    }
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_editor_saves WHERE session_id=$1 AND result IS NOT NULL",&session).await,129);
    for index in 0..127 {
        prepare(
            &server,
            &cookie,
            input(&document, &format!("pending:{index}"), PDF_EDIT),
        )
        .await;
    }
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "pending:total-bound", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_saves WHERE session_id=$1",
            &session
        )
        .await,
        256
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
            vec![session.clone().into()],
        ))
        .await
        .unwrap();
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE id=$1",
            &session
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        0
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS automatic-save retention, rollback and restart"]
async fn automatic_retention_fences_retired_ids_and_close_releases_256_rows() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("hyori_server::db=debug,hyori_server::error=error")
        .with_test_writer()
        .try_init();
    let (pg, _fs, mut server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "automatic.pdf", PDF, None).await;
    let mut document = open(&server, &cookie, &file).await;
    assert_eq!(document["bridge"], "upstream-host-parent");
    assert!(document["protocol"].is_null());
    let session = document["sessionId"].as_str().unwrap().to_owned();
    let mut requests = Vec::new();
    for index in 1..=128 {
        requests.push(
            save(
                &server,
                &cookie,
                &mut document,
                &format!("auto:{index}"),
                true,
            )
            .await,
        );
    }
    assert_eq!(history_count(&server, &file).await, 1);
    // Force the pruning transaction to fail after it has updated the fence. Neither half commits.
    server.state.db.execute_unprepared("CREATE FUNCTION fixture_prune_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER fixture_prune_failure BEFORE DELETE ON hyori_editor_saves FOR EACH ROW EXECUTE FUNCTION fixture_prune_failure()").await.unwrap();
    let mut next = input(&document, "auto:129", PDF_EDIT);
    next["saveMode"] = json!("automatic");
    let pending = prepare(&server, &cookie, next.clone()).await;
    assert_eq!(
        put(&server, &cookie, &pending, PDF_EDIT).await.status(),
        200
    );
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":session,"saveId":"auto:129"}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_editor_saves WHERE session_id=$1 AND result IS NOT NULL",&session).await,128);
    assert_eq!(scalar(&server,"SELECT (retired_ids=decode(repeat('00',131072),'hex'))::integer::bigint AS n FROM hyori_editor_sessions WHERE id=$1",&session).await,1);
    server.state.db.execute_unprepared("DROP TRIGGER fixture_prune_failure ON hyori_editor_saves; DROP FUNCTION fixture_prune_failure()").await.unwrap();
    let result = finish(&server, &cookie, &document, "auto:129").await;
    document["revision"] = result["revision"].clone();
    requests.push((pending, next));
    // Competing writes can prune only with the winning atomic revision publication.
    let mut left = input(&document, "auto:130:left", PDF_EDIT);
    left["saveMode"] = json!("automatic");
    let mut right = left.clone();
    right["saveId"] = json!("auto:130:right");
    let l = prepare(&server, &cookie, left).await;
    let r = prepare(&server, &cookie, right).await;
    assert_eq!(put(&server, &cookie, &l, PDF_EDIT).await.status(), 200);
    assert_eq!(put(&server, &cookie, &r, PDF_EDIT).await.status(), 200);
    let (a, b) = tokio::join!(
        server.rpc(
            "editors.completeSave",
            json!({"sessionId":session,"saveId":"auto:130:left"}),
            Some(&cookie)
        ),
        server.rpc(
            "editors.completeSave",
            json!({"sessionId":session,"saveId":"auto:130:right"}),
            Some(&cookie)
        )
    );
    let (winner, loser) = if a.status == 200 {
        b.error(409, "resource.conflict");
        (a, l.clone())
    } else {
        a.error(409, "resource.conflict");
        (b, r.clone())
    };
    // The losing mapping is deliberately retained, so close must handle it too.
    document["revision"] = winner.value()["revision"].clone();
    let _ = loser;
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    server
        .rpc("editors.prepareSave", requests[0].1.clone(), Some(&cookie))
        .await
        .error(409, "resource.conflict");
    let mut reused = input(&document, "auto:1", PDF);
    reused["saveMode"] = json!("automatic");
    server
        .rpc("editors.prepareSave", reused, Some(&cookie))
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":session,"saveId":"auto:1"}),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    assert_eq!(
        prepare(&server, &cookie, requests[2].1.clone()).await,
        requests[2].0
    );
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_editor_saves WHERE session_id=$1 AND result IS NOT NULL",&session).await,128);
    // Quota remains charged before exact-key physical deletion.
    let before = scalar(
        &server,
        "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
        &owner,
    )
    .await;
    for pass in 0..40 {
        let result = cleanup::reclaim(&server.state).await;
        assert!(result.is_ok(), "cleanup pass {pass}: {result:?}");
    }
    let after = scalar(
        &server,
        "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
        &owner,
    )
    .await;
    assert!(after < before);
    let inventory = scalar(
        &server,
        "SELECT coalesce(sum(size),0)::bigint AS n FROM hyori_objects WHERE owner_id=$1",
        &owner,
    )
    .await;
    assert_eq!(after, inventory);
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_uploads WHERE owner_id=$1 AND editor_superseded AND editor_reclaimed_at IS NULL",&owner).await,0);
    // Saturation is a conservative availability failure; retained exact replay still comes first.
    let saturated = vec![255_u8; 128 * 1024];
    let checksum = hex::encode(Sha256::digest(&saturated));
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_sessions SET retired_ids=$2,retired_ids_sha256=$3 WHERE id=$1",
            vec![session.clone().into(), saturated.into(), checksum.into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        prepare(&server, &cookie, requests[2].1.clone()).await,
        requests[2].0
    );
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "brand-new", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_sessions SET retired_ids_sha256=repeat('0',64) WHERE id=$1",
            vec![session.clone().into()],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "brand-new", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    // Restore the verified pre-saturation fence from its deterministic retired IDs in a fixture:
    // instead use a new session to test both independent admission buckets without erasing IDs.
    server
        .rpc("editors.close", json!({"sessionId":session}), Some(&cookie))
        .await
        .value();
    let mut document = open(&server, &cookie, &file).await;
    let session = document["sessionId"].as_str().unwrap().to_owned();
    for index in 0..128 {
        save(
            &server,
            &cookie,
            &mut document,
            &format!("durable:{index}"),
            true,
        )
        .await;
    }
    for index in 0..128 {
        prepare(
            &server,
            &cookie,
            input(&document, &format!("pending:{index}"), PDF_EDIT),
        )
        .await;
    }
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_saves WHERE session_id=$1",
            &session
        )
        .await,
        256
    );
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "pending:overflow", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    server
        .rpc("editors.close", json!({"sessionId":session}), Some(&cookie))
        .await
        .value();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE id=$1",
            &session
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        0
    );
    assert!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_uploads WHERE owner_id=$1",
            &owner
        )
        .await
            >= 386
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS automatic history policy"]
async fn automatic_history_checkpoints_time_manual_other_session_and_references() {
    let (pg, _fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "history.pdf", PDF, None).await;
    let mut document = open(&server, &cookie, &file).await;
    let session = document["sessionId"].as_str().unwrap().to_owned();
    save(&server, &cookie, &mut document, "auto:1", true).await;
    save(&server, &cookie, &mut document, "auto:2", true).await;
    assert_eq!(history_count(&server, &file).await, 1);
    server.state.db.execute_raw(sql("UPDATE hyori_editor_sessions SET checkpoint_at=now()-interval '60 seconds' WHERE id=$1",vec![session.clone().into()])).await.unwrap();
    save(&server, &cookie, &mut document, "auto:3", true).await;
    assert_eq!(history_count(&server, &file).await, 2);
    save(&server, &cookie, &mut document, "manual:1", false).await;
    assert_eq!(history_count(&server, &file).await, 3);
    save(&server, &cookie, &mut document, "auto:4", true).await;
    assert_eq!(history_count(&server, &file).await, 4);
    save(&server, &cookie, &mut document, "auto:5", true).await;
    assert_eq!(history_count(&server, &file).await, 4);
    let other = open(&server, &cookie, &file).await;
    save(&server, &cookie, &mut document, "auto:6", true).await;
    assert_eq!(history_count(&server, &file).await, 5);
    server
        .rpc(
            "editors.close",
            json!({"sessionId":other["sessionId"]}),
            Some(&cookie),
        )
        .await
        .value();
    // An independent retained version of the current key forces a checkpoint, never collection.
    server.state.db.execute_raw(sql("INSERT INTO hyori_versions(id,file_id,owner_id,object_key,size,mime_type,created_at) SELECT 'fixture-reference',id,owner_id,object_key,size,mime_type,now() FROM hyori_items WHERE id=$1",vec![file["id"].as_str().unwrap().into()])).await.unwrap();
    save(&server, &cookie, &mut document, "auto:7", true).await;
    assert_eq!(history_count(&server, &file).await, 7);
    let mut invalid = input(&document, "copy:auto", PDF_EDIT);
    invalid["saveMode"] = json!("automatic");
    invalid["intent"] = json!("save-as");
    invalid["destination"] = json!({"parentId":null});
    invalid["name"] = json!("copy.pdf");
    server
        .rpc("editors.prepareSave", invalid, Some(&cookie))
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":file["id"],"versionId":"fixture-reference"}),
            Some(&cookie),
        )
        .await
        .value();
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "after-restore", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    let mut restored = open(&server, &cookie, &file).await;
    save(&server, &cookie, &mut restored, "auto:new-session", true).await;
    assert_eq!(history_count(&server, &file).await, 9);
    pg.stop();
}

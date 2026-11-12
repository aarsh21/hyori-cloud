use super::{
    PDF, PDF_EDIT, TestServer, automatic::save, enable, fault_proxy, open, scalar, setup, upload,
};
use hyori_server::{
    db::sql,
    features::{admin::purge, uploads::cleanup},
};
use sea_orm::ConnectionTrait;
use serde_json::json;
use std::sync::atomic::Ordering;

async fn due(server: &TestServer, owner: &str) {
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_uploads SET cleanup_due=now(),cleanup_until=NULL WHERE owner_id=$1",
            vec![owner.into()],
        ))
        .await
        .unwrap();
}
#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS exact-key automatic GC fault recovery"]
async fn automatic_gc_holds_quota_on_failure_and_retries_late_effects_without_double_charge() {
    let (mut pg, fs, server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "gc.pdf", PDF, None).await;
    let mut document = open(&server, &cookie, &file).await;
    let (old, _) = save(&server, &cookie, &mut document, "auto:1", true).await;
    save(&server, &cookie, &mut document, "auto:2", true).await;
    let key: String = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1",
            vec![old.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "object_key")
        .unwrap();
    let before = scalar(
        &server,
        "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
        &owner,
    )
    .await;
    assert_eq!(before, (PDF.len() + PDF_EDIT.len() * 2) as i64);
    let proxy = fault_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    pg.config.storage.as_mut().unwrap().endpoint = proxy.endpoint.clone();
    drop(server);
    let mut server = TestServer::start(pg.config.clone()).await;
    proxy.fault.store(2, Ordering::SeqCst);
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        before
    );
    proxy.fault.store(0, Ordering::SeqCst);
    server.state.db.execute_unprepared("CREATE FUNCTION fixture_gc_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture gc rollback'; END $$; CREATE TRIGGER fixture_gc_failure BEFORE DELETE ON hyori_objects FOR EACH ROW EXECUTE FUNCTION fixture_gc_failure()").await.unwrap();
    due(&server, &owner).await;
    assert!(cleanup::reclaim(&server.state).await.is_err());
    assert!(
        server
            .state
            .storage
            .as_ref()
            .unwrap()
            .head(&key)
            .await
            .is_err()
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        before
    );
    server
        .state
        .db
        .execute_unprepared(
            "DROP TRIGGER fixture_gc_failure ON hyori_objects; DROP FUNCTION fixture_gc_failure()",
        )
        .await
        .unwrap();
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    due(&server, &owner).await;
    cleanup::reclaim(&server.state).await.unwrap();
    let expected = (PDF.len() + PDF_EDIT.len()) as i64;
    assert_eq!(
        scalar(
            &server,
            "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        expected
    );
    // Simulate a late storage effect at the exact historical key, not a new product write.
    let storage = server.state.storage.as_ref().unwrap();
    let multipart = storage.begin(&key, "application/pdf").await.unwrap();
    let etag = storage
        .part(
            &key,
            &multipart,
            1,
            PDF_EDIT.len() as u64,
            Box::pin(futures_util::stream::once(async {
                Ok(hyori_storage::Bytes::from_static(PDF_EDIT))
            })),
        )
        .await
        .unwrap();
    storage
        .complete(
            &key,
            &multipart,
            &[hyori_storage::PartRef {
                part_number: 1,
                etag,
            }],
            PDF_EDIT.len() as u64,
        )
        .await
        .unwrap();
    due(&server, &owner).await;
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(
        server
            .state
            .storage
            .as_ref()
            .unwrap()
            .head(&key)
            .await
            .is_err()
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT used_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        expected
    );
    let keys = server
        .state
        .db
        .query_all_raw(sql(
            "SELECT object_key FROM hyori_objects WHERE owner_id=$1",
            vec![owner.clone().into()],
        ))
        .await
        .unwrap();
    assert_eq!(keys.len(), 2);
    for row in keys {
        server
            .state
            .storage
            .as_ref()
            .unwrap()
            .head(&row.try_get::<String>("", "object_key").unwrap())
            .await
            .unwrap();
    }
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_uploads WHERE id=$1 AND state='complete' AND editor_superseded AND editor_reclaimed_at IS NOT NULL",&old).await,1);
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS automatic GC and account-purge race"]
async fn automatic_gc_account_purge_fences_inflight_acknowledgement() {
    let (mut pg, fs, server, _admin_id, admin) = setup().await;
    enable(&server).await;
    let user=server.rpc("admin.createUser",json!({"email":"gc-purge@example.test","name":"GC","password":"long-fixture-password-for-gc"}),Some(&admin)).await.value()["id"].as_str().unwrap().to_owned();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":"gc-purge@example.test","password":"long-fixture-password-for-gc"}),
            None,
        )
        .await
        .credential();
    let file = upload(&server, &cookie, "purge.pdf", PDF, None).await;
    let mut document = open(&server, &cookie, &file).await;
    save(&server, &cookie, &mut document, "auto:1", true).await;
    save(&server, &cookie, &mut document, "auto:2", true).await;
    let proxy = fault_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    pg.config.storage.as_mut().unwrap().endpoint = proxy.endpoint.clone();
    drop(server);
    let server = TestServer::start(pg.config.clone()).await;
    proxy.fault.store(6, Ordering::SeqCst);
    let state = server.state.clone();
    let cleanup = tokio::spawn(async move { cleanup::reclaim(&state).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        proxy.read_entered.notified(),
    )
    .await
    .unwrap();
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":user,"confirmEmail":"gc-purge@example.test"}),
            Some(&admin),
        )
        .await
        .value();
    purge::reclaim(&server.state).await.unwrap();
    proxy.release_read.notify_one();
    cleanup.await.unwrap().unwrap();
    for _ in 0..16 {
        server
            .state
            .db
            .execute_raw(sql(
                "UPDATE hyori_account_purges SET due_at=now(),lease_until=NULL WHERE user_id=$1",
                vec![user.clone().into()],
            ))
            .await
            .unwrap();
        due(&server, &user).await;
        purge::reclaim(&server.state).await.unwrap();
        if scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_users WHERE id=$1 AND status='deleted'",
            &user,
        )
        .await
            == 1
        {
            break;
        }
    }
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_users WHERE id=$1 AND status='deleted' AND used_bytes=0 AND reserved_bytes=0",&user).await,1);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_objects WHERE owner_id=$1",
            &user
        )
        .await,
        0
    );
    assert_eq!(scalar(&server,"SELECT count(*) AS n FROM hyori_uploads WHERE owner_id=$1 AND state='aborted' AND purged",&user).await,3);
    pg.stop();
}

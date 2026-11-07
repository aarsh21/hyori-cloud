use super::{
    PDF, PDF_EDIT, TestServer, enable, fault_proxy, finish, input, open, prepare, put, scalar,
    setup, upload,
};
use hyori_server::db::sql;
use sea_orm::ConnectionTrait;
use serde_json::json;

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS download inspection revision race"]
async fn original_download_rechecks_revision_after_slow_storage_inspection() {
    use std::sync::atomic::Ordering;
    let (pg, fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "race.pdf", PDF, None).await;
    let opened = open(&server, &cookie, &file).await;
    let descriptor = super::descriptor(&server, &cookie, &opened).await;
    let proxy = fault_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = pg.config.clone();
    config.storage.as_mut().unwrap().endpoint = proxy.endpoint.clone();
    let delayed = TestServer::start(config).await;
    proxy.fault.store(4, Ordering::SeqCst);
    let request = delayed
        .client
        .get(format!(
            "{}{}",
            delayed.url,
            descriptor["url"].as_str().unwrap()
        ))
        .header("host", "localhost:3001")
        .header("origin", &delayed.state.config.origin)
        .header("cookie", &cookie);
    let download = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        proxy.read_entered.notified(),
    )
    .await
    .unwrap();
    let second = open(&server, &cookie, &file).await;
    let upload = prepare(
        &server,
        &cookie,
        input(&second, "replace-during-inspection", PDF_EDIT),
    )
    .await;
    assert_eq!(put(&server, &cookie, &upload, PDF_EDIT).await.status(), 200);
    finish(&server, &cookie, &second, "replace-during-inspection").await;
    proxy.release_read.notify_one();
    assert_eq!(download.await.unwrap().status(), 409);
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS editor storage-failure reconciliation"]
async fn lost_begin_and_ambiguous_complete_reconcile_same_intent_after_restart() {
    use std::sync::atomic::Ordering;
    let (mut pg, fs, server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "outage.pdf", PDF, None).await;
    let document = open(&server, &cookie, &file).await;
    let proxy = fault_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    pg.config.storage.as_mut().unwrap().endpoint = proxy.endpoint.clone();
    drop(server);
    let mut server = TestServer::start(pg.config.clone()).await;
    let prepare_input = input(&document, "durable", PDF_EDIT);
    proxy.fault.store(1, Ordering::SeqCst);
    server
        .rpc("editors.prepareSave", prepare_input.clone(), Some(&cookie))
        .await
        .error(503, "service.unavailable");
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT upload_id FROM hyori_editor_saves WHERE session_id=$1 AND save_id='durable'",
            vec![document["sessionId"].as_str().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let reserved: String = row.try_get("", "upload_id").unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        PDF_EDIT.len() as i64
    );
    proxy.fault.store(0, Ordering::SeqCst);
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    assert_eq!(prepare(&server, &cookie, prepare_input).await, reserved);
    proxy.fault.store(2, Ordering::SeqCst);
    assert_eq!(
        put(&server, &cookie, &reserved, PDF_EDIT).await.status(),
        503
    );
    proxy.fault.store(0, Ordering::SeqCst);
    assert_eq!(
        put(&server, &cookie, &reserved, PDF_EDIT).await.status(),
        200
    );
    proxy.fault.store(3, Ordering::SeqCst);
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":document["sessionId"],"saveId":"durable"}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        0
    );
    proxy.fault.store(0, Ordering::SeqCst);
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    let result = finish(&server, &cookie, &document, "durable").await;
    assert_eq!(result["revision"], "1");
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        1
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
    hyori_server::features::uploads::cleanup::reclaim(&server.state)
        .await
        .unwrap();
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE id=$1",
            vec![reserved.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    assert!(
        !server
            .state
            .storage
            .as_ref()
            .unwrap()
            .abort_unfinished(&key, None)
            .await
            .unwrap()
            .pending
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS editor move/trash/deleting-account fencing"]
async fn move_trash_and_account_deletion_invalidate_inflight_editor_publication() {
    let (pg, _fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "state.pdf", PDF, None).await;
    let destination = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Destination"}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let before_move = open(&server, &cookie, &file).await;
    let pending = prepare(&server, &cookie, input(&before_move, "moved", PDF_EDIT)).await;
    server
        .rpc(
            "files.move",
            json!({"id":file["id"],"parentId":destination["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(
        put(&server, &cookie, &pending, PDF_EDIT).await.status(),
        409
    );
    let after_move = open(&server, &cookie, &file).await;
    let pending = prepare(&server, &cookie, input(&after_move, "trashed", PDF_EDIT)).await;
    assert_eq!(
        put(&server, &cookie, &pending, PDF_EDIT).await.status(),
        200
    );
    server
        .rpc("files.trash", json!({"id":file["id"]}), Some(&cookie))
        .await
        .value();
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":pending}),
            Some(&cookie),
        )
        .await
        .error(404, "resource.notFound");
    let recipient=server.rpc("admin.createUser",json!({"email":"delete-editor@example.test","name":"Delete editor","password":"long-test-password-for-delete"}),Some(&cookie)).await.value().clone();
    let editor=server.rpc("auth.login",json!({"email":"delete-editor@example.test","password":"long-test-password-for-delete"}),None).await.credential();
    let file = upload(&server, &editor, "owned.pdf", PDF, None).await;
    let document = open(&server, &editor, &file).await;
    let pending = prepare(&server, &editor, input(&document, "deleting", PDF_EDIT)).await;
    assert_eq!(
        put(&server, &editor, &pending, PDF_EDIT).await.status(),
        200
    );
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":recipient["id"],"confirmEmail":"delete-editor@example.test"}),
            Some(&cookie),
        )
        .await
        .value();
    let denied = server
        .rpc(
            "uploads.complete",
            json!({"uploadId":pending}),
            Some(&editor),
        )
        .await;
    assert!(!denied.body["ok"].as_bool().unwrap());
    // admin.deleteUser only commits the deletion; maintenance's purge pass removes sessions.
    hyori_server::features::admin::purge::reclaim(&server.state)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1 OR initiator_id=$1",
            recipient["id"].as_str().unwrap()
        )
        .await,
        0
    );
    pg.stop();
}

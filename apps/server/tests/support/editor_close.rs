use super::{
    PDF, PDF_EDIT, TestServer, enable, fault_proxy, finish, input, open, prepare, put, scalar,
    setup, upload,
};
use hyori_server::db::sql;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};

async fn close(server: &TestServer, cookie: Option<&str>, document: &Value) {
    assert_eq!(
        server
            .rpc(
                "editors.close",
                json!({"sessionId":document["sessionId"]}),
                cookie
            )
            .await
            .value(),
        &json!({"success":true})
    );
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS sequential editor close admission and identity"]
async fn explicit_close_releases_admission_without_raising_caps_or_closing_other_handles() {
    let (pg, _fs, server, owner_id, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "many-opens.pdf", PDF, None).await;
    for _ in 0..40 {
        let document = open(&server, &owner, &file).await;
        close(&server, Some(&owner), &document).await;
        close(&server, Some(&owner), &document).await;
    }
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        0
    );
    let mut active = Vec::new();
    for _ in 0..32 {
        active.push(open(&server, &owner, &file).await);
    }
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&owner))
        .await
        .error(409, "resource.conflict");
    server.rpc("admin.createUser",json!({"email":"foreign-close@example.test","name":"Foreign","password":"long-test-password-for-foreign-close"}),Some(&owner)).await.value();
    let foreign=server.rpc("auth.login",json!({"email":"foreign-close@example.test","password":"long-test-password-for-foreign-close"}),None).await.credential();
    close(&server, Some(&foreign), &active[0]).await;
    close(&server, None, &active[0]).await;
    close(&server, Some(&foreign), &json!({"sessionId":"missing"})).await;
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        32
    );
    // A simultaneous open may observe the still-full admission snapshot; it must not exceed the cap.
    let (closed, opened) = tokio::join!(
        server.rpc(
            "editors.close",
            json!({"sessionId":active[0]["sessionId"]}),
            Some(&owner)
        ),
        server.rpc("editors.open", json!({"id":file["id"]}), Some(&owner))
    );
    closed.value();
    if opened.status == 200 {
        active[0] = opened.value().clone();
    } else {
        assert!([409, 503].contains(&opened.status));
        active[0] = open(&server, &owner, &file).await;
    }
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        32
    );
    server
        .rpc("files.trash", json!({"id":file["id"]}), Some(&owner))
        .await
        .value();
    server
        .state
        .db
        .execute_raw(sql("UPDATE hyori_editor_assets SET enabled=false", vec![]))
        .await
        .unwrap();
    for document in active {
        close(&server, Some(&owner), &document).await;
    }
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        0
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS exact anonymous editor-close identity"]
async fn anonymous_self_close_uses_exact_issued_grant_even_after_source_revocation() {
    let (pg, _fs, server, owner_id, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "anonymous-close.pdf", PDF, None).await;
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":file["id"],"public":true,"role":"editor"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let token = link["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let holder = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let other = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let document = open(&server, &holder, &file).await;
    close(&server, Some(&other), &document).await;
    close(&server, Some(&owner), &document).await;
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        1
    );
    server
        .rpc("shares.revoke", json!({"id":link["id"]}), Some(&owner))
        .await
        .value();
    close(&server, Some(&holder), &document).await;
    close(&server, Some(&holder), &document).await;
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        0
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS close fences late begin and publication while preserving committed history"]
async fn close_fences_inflight_prepare_publication_and_replay_without_deleting_saved_files() {
    use std::sync::atomic::Ordering;
    let (pg, fs, server, owner_id, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "close-save.pdf", PDF, None).await;
    let committed = open(&server, &owner, &file).await;
    let id = prepare(&server, &owner, input(&committed, "saved", PDF_EDIT)).await;
    assert_eq!(put(&server, &owner, &id, PDF_EDIT).await.status(), 200);
    finish(&server, &owner, &committed, "saved").await;
    close(&server, Some(&owner), &committed).await;
    assert_eq!(
        server
            .rpc("files.get", json!({"id":file["id"]}), Some(&owner))
            .await
            .value()["size"],
        PDF_EDIT.len()
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        1
    );
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":committed["sessionId"],"saveId":"saved"}),
            Some(&owner),
        )
        .await
        .error(404, "resource.notFound");
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&owner))
        .await
        .error(404, "resource.notFound");
    let proxy = fault_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = pg.config.clone();
    config.storage.as_mut().unwrap().endpoint = proxy.endpoint.clone();
    let delayed = TestServer::start(config).await;
    let pending = open(&server, &owner, &file).await;
    proxy.fault.store(5, Ordering::SeqCst);
    let request = delayed
        .client
        .post(format!("{}/api/rpc", delayed.url))
        .header("origin", &pg.config.origin)
        .header("host", "localhost:3001")
        .header("cookie", &owner)
        .json(&json!({"operation":"editors.prepareSave","input":input(&pending,"late-begin",PDF)}));
    let preparing = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        proxy.read_entered.notified(),
    )
    .await
    .unwrap();
    close(&server, Some(&owner), &pending).await;
    proxy.release_read.notify_one();
    assert_eq!(preparing.await.unwrap().status(), 404);
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS n FROM hyori_users WHERE id=$1",
            &owner_id
        )
        .await,
        0
    );
    let pending = open(&server, &owner, &file).await;
    let id = prepare(&server, &owner, input(&pending, "late-publication", PDF)).await;
    assert_eq!(put(&server, &owner, &id, PDF).await.status(), 200);
    proxy.fault.store(4, Ordering::SeqCst);
    let request=delayed.client.post(format!("{}/api/rpc",delayed.url)).header("origin",&pg.config.origin).header("host","localhost:3001").header("cookie",&owner).json(&json!({"operation":"editors.completeSave","input":{"sessionId":pending["sessionId"],"saveId":"late-publication"}}));
    let publishing = tokio::spawn(async move { request.send().await.unwrap() });
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        proxy.read_entered.notified(),
    )
    .await
    .unwrap();
    close(&server, Some(&owner), &pending).await;
    proxy.release_read.notify_one();
    assert_eq!(publishing.await.unwrap().status(), 404);
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
            &owner_id
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner_id
        )
        .await,
        0
    );
    let upload = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT state,object_key FROM hyori_uploads WHERE id=$1",
            vec![id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(upload.try_get::<String>("", "state").unwrap(), "aborted");
    hyori_server::features::uploads::cleanup::reclaim(&server.state)
        .await
        .unwrap();
    assert!(
        server
            .state
            .storage
            .as_ref()
            .unwrap()
            .read(&upload.try_get::<String>("", "object_key").unwrap(), None)
            .await
            .is_err()
    );
    let reopened = open(&server, &owner, &file).await;
    close(&server, Some(&owner), &reopened).await;
    pg.stop();
}

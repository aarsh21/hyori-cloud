use super::*;

async fn resolve(server: &TestServer, token: &str, cookie: &str) -> String {
    let reply = server
        .rpc("shares.resolve", json!({"token": token}), Some(cookie))
        .await;
    assert_eq!(reply.value()["requiresPassword"], false);
    reply.credential()
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS, two HTTP instances and deterministic storage-response gates"]
async fn anonymous_uploads_survive_same_link_resolution_without_broadening_initiator_authority() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let proxy = Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = proxy.endpoint.clone();
    pg.config.storage = Some(config);
    let server = TestServer::start(pg.config.clone()).await;
    let second = TestServer::start(pg.config.clone()).await;
    let (owner, admin) = setup(&server).await;
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Continuity"}),
            Some(&admin),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let link = server.rpc("shares.create", json!({"itemId":folder,"public":true,"role":"contributor","password":"continuity password"}), Some(&admin)).await;
    let token = share_token(link.value());
    let opened = server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"continuity password"}),
            None,
        )
        .await;
    opened.value();
    let grant = opened.credential();
    let stranger = second
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"continuity password"}),
            None,
        )
        .await
        .credential();
    assert_ne!(grant, stranger);
    let original_expiry = link_capability::times(grant.split_once('=').unwrap().1).1;
    let id = begin(&server, &grant, "resumed", 5, Some(&folder), None).await;
    second
        .rpc("uploads.status", json!({"uploadId":id}), Some(&stranger))
        .await
        .error(403, "access.denied");
    second
        .rpc("uploads.abort", json!({"uploadId":id}), Some(&stranger))
        .await
        .error(403, "access.denied");

    // Real storage has consumed the part; resolving in another tab must not strand its acknowledgement.
    proxy.faults.mode.store(2, Ordering::SeqCst);
    let writing = put(&server, &grant, &id, b"hello");
    let refreshing = async {
        proxy.faults.reached.notified().await;
        assert_eq!(resolve(&second, token, &grant).await, grant);
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (written, ()) = tokio::join!(writing, refreshing);
    assert_eq!(written.status(), 200);
    // A new HTTP instance reconstructs the checkpoint from PostgreSQL and the same browser cookie.
    let restarted = TestServer::start(pg.config.clone()).await;
    let fresh_cookie = resolve(&restarted, token, &grant).await;
    assert_eq!(fresh_cookie, grant);
    assert_eq!(
        restarted
            .rpc(
                "uploads.status",
                json!({"uploadId":id}),
                Some(&fresh_cookie)
            )
            .await
            .value()["parts"][0]["size"],
        5
    );

    // The same continuity must hold between storage completion and the atomic metadata publication.
    proxy.faults.mode.store(3, Ordering::SeqCst);
    let completing = restarted.rpc(
        "uploads.complete",
        json!({"uploadId":id}),
        Some(&fresh_cookie),
    );
    let refreshing = async {
        proxy.faults.reached.notified().await;
        assert_eq!(resolve(&second, token, &fresh_cookie).await, fresh_cookie);
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (published, ()) = tokio::join!(completing, refreshing);
    let file = published.value();
    assert_eq!(
        get(&server, &fresh_cookie, file["id"].as_str().unwrap(), None)
            .await
            .bytes()
            .await
            .unwrap(),
        "hello"
    );
    assert_eq!(accounting(&server, &owner).await, (5, 0));

    let cancelled = begin(&server, &fresh_cookie, "cancelled", 1, Some(&folder), None).await;
    let refreshed = resolve(&second, token, &fresh_cookie).await;
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":cancelled}),
            Some(&refreshed),
        )
        .await
        .value();
    assert_eq!(accounting(&server, &owner).await, (5, 0));
    // Two browsers opened the link, and nothing was stored; this one kept its first expiry.
    assert_ne!(grant, stranger);
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS count FROM hyori_grants WHERE share_id=$1",
            vec![link.value()["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    assert_eq!(
        link_capability::times(refreshed.split_once('=').unwrap().1).1,
        original_expiry
    );

    // An expired credential is NOT renewed or silently given ownership of its old pending upload.
    let expiring = begin(&server, &refreshed, "expired", 1, Some(&folder), None).await;
    // The browser after its capability's 12 hours.
    let (name, _) = refreshed.split_once('=').unwrap();
    let refreshed = format!(
        "{name}={}",
        link_capability::expired(&server, link.value()["id"].as_str().unwrap()).await
    );
    let locked = server
        .rpc("shares.resolve", json!({"token":token}), Some(&refreshed))
        .await;
    assert_eq!(locked.value()["requiresPassword"], true);
    assert!(locked.cookies.is_empty());
    let renewed = server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"continuity password"}),
            Some(&refreshed),
        )
        .await
        .credential();
    assert_ne!(renewed, refreshed);
    server
        .rpc(
            "uploads.status",
            json!({"uploadId":expiring}),
            Some(&renewed),
        )
        .await
        .error(403, "access.denied");
    let revoked = begin(&server, &renewed, "revoked", 1, Some(&folder), None).await;
    server
        .rpc(
            "shares.revoke",
            json!({"id":link.value()["id"]}),
            Some(&admin),
        )
        .await
        .value();
    server
        .rpc(
            "uploads.status",
            json!({"uploadId":revoked}),
            Some(&renewed),
        )
        .await
        .error(403, "access.denied");
    drop(restarted);
    drop(second);
    drop(server);
    pg.stop();
}

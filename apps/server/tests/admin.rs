#[path = "support/admin_fixture.rs"]
mod fixture;
#[path = "support/storage.rs"]
mod storage;
mod support;
use fixture::*;
use hyori_server::{
    db::sql,
    features::{admin::purge, uploads::cleanup},
};
use hyori_storage::ObjectStorage;
use sea_orm::ConnectionTrait;
use serde_json::json;
use std::sync::atomic::Ordering;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real PostgreSQL admin privacy, pagination and metadata-only purge"]
async fn admin_scope_pagination_quota_confirmation_and_storage_absence() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let (admin, admin_cookie) = setup(&server).await;
    let (user, cookie) = account(&server, &admin_cookie, "user@example.test").await;
    let private = folder(&server, &cookie, "private-filename").await;
    server
        .rpc("admin.users", json!({}), None)
        .await
        .error(401, "auth.required");
    server
        .rpc("admin.users", json!({}), Some(&cookie))
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":user,"quotaBytes":1}),
            Some(&cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc("files.get", json!({"id":private}), Some(&admin_cookie))
        .await
        .error(403, "access.denied");
    server.state.db.execute_raw(sql("INSERT INTO hyori_users(id,email,name,role,quota_bytes) SELECT 'pagination_'||lpad(n::text,3,'0'),'fixture-'||n||'@example.test','Page fixture','user',100 FROM generate_series(1,100) n",vec![])).await.unwrap();
    let first = server
        .rpc("admin.users", json!({}), Some(&admin_cookie))
        .await;
    assert_eq!(first.value()["items"].as_array().unwrap().len(), 100);
    assert!(!first.body.to_string().contains("private-filename"));
    assert!(!first.body.to_string().contains("objectKey"));
    let second = server
        .rpc(
            "admin.users",
            json!({"cursor":first.value()["nextCursor"]}),
            Some(&admin_cookie),
        )
        .await;
    assert_eq!(second.value()["items"].as_array().unwrap().len(), 2);
    assert_eq!(second.value()["nextCursor"], json!(null));
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":user,"quotaBytes":9007199254740992_u64}),
            Some(&admin_cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":user,"quotaBytes":1.5}),
            Some(&admin_cookie),
        )
        .await
        .error(400, "input.invalid");
    assert_eq!(
        server
            .rpc(
                "admin.setQuota",
                json!({"userId":user,"quotaBytes":0}),
                Some(&admin_cookie)
            )
            .await
            .value()["quotaBytes"],
        0
    );
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":admin,"confirmEmail":"admin@example.test"}),
            Some(&admin_cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":user,"confirmEmail":"User@example.test"}),
            Some(&admin_cookie),
        )
        .await
        .error(400, "input.invalid");
    let deleting = server
        .rpc(
            "admin.deleteUser",
            json!({"userId":user,"confirmEmail":"user@example.test"}),
            Some(&admin_cookie),
        )
        .await;
    assert_eq!(deleting.value()["state"], "pending");
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&cookie))
            .await
            .value()["user"],
        json!(null)
    );
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":user,"quotaBytes":99}),
            Some(&admin_cookie),
        )
        .await
        .error(409, "resource.conflict");
    due(&server).await;
    purge::reclaim(&server.state).await.unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_users WHERE id=$1 AND status='deleting'",
            &user
        )
        .await,
        1,
        "metadata-only mode cannot certify object removal"
    );
    server.state.db.execute_raw(sql("UPDATE hyori_account_purges SET lease_token='crashed-worker',lease_until=now()+interval '1 minute',due_at=now() WHERE user_id=$1",vec![user.clone().into()])).await.unwrap();
    assert_eq!(
        purge::reclaim(&server.state).await.unwrap(),
        0,
        "an unexpired worker lease is not stolen"
    );
    let restarted = TestServer::start(pg.config.clone()).await;
    server.state.db.execute_raw(sql("UPDATE hyori_account_purges SET lease_until=now()-interval '1 second' WHERE user_id=$1",vec![user.clone().into()])).await.unwrap();
    assert_eq!(
        purge::reclaim(&restarted.state).await.unwrap(),
        1,
        "expired leases recover after process reconstruction"
    );
    assert_eq!(scalar(&server,"SELECT count(*) AS count FROM hyori_account_purges WHERE user_id=$1 AND lease_token IS NULL AND due_at>now() AND completed_at IS NULL",&user).await,1,"failed attempts retain a fair future due time and no completion claim");
    server
        .rpc("auth.logout", json!({}), Some(&admin_cookie))
        .await
        .value();
    server
        .rpc("admin.users", json!({}), Some(&admin_cookie))
        .await
        .error(401, "auth.required");
    pg.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL/pinned RustFS bounded account purge, outage/restart and concurrent workers"]
async fn purge_owned_hierarchy_versions_photos_and_credentials_preserves_contributions() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let proxy = Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = proxy.endpoint.clone();
    pg.config.storage = Some(config);
    let mut server = TestServer::start(pg.config.clone()).await;
    let (admin, admin_cookie) = setup(&server).await;
    let (target, target_cookie) = account(&server, &admin_cookie, "target@example.test").await;
    let (other, other_cookie) = account(&server, &admin_cookie, "other@example.test").await;
    let owned = folder(&server, &target_cookie, "private-original-folder").await;
    let destination = folder(&server, &other_cookie, "surviving-destination").await;
    server
        .rpc(
            "shares.create",
            json!({"itemId":destination,"recipientId":target,"role":"contributor","public":false}),
            Some(&other_cookie),
        )
        .await
        .value();
    let contributed = upload(
        &server,
        &target_cookie,
        Some(&destination),
        "surviving-contribution.png",
        None,
    )
    .await;
    let contributed_id = contributed["id"].as_str().unwrap();
    let pending_contribution = begin(
        &server,
        &target_cookie,
        Some(&destination),
        "unfinished-contribution.png",
        None,
    )
    .await;
    part(&server, &target_cookie, &pending_contribution).await;
    let original = upload(
        &server,
        &target_cookie,
        Some(&owned),
        "private-original.png",
        None,
    )
    .await;
    let original_id = original["id"].as_str().unwrap();
    upload(
        &server,
        &target_cookie,
        Some(&owned),
        "private-original.png",
        Some(original_id),
    )
    .await;
    let trash = upload(
        &server,
        &target_cookie,
        Some(&owned),
        "private-trash.png",
        None,
    )
    .await;
    server
        .rpc(
            "files.trash",
            json!({"id":trash["id"]}),
            Some(&target_cookie),
        )
        .await
        .value();
    let pending_owned = begin(
        &server,
        &target_cookie,
        Some(&owned),
        "private-incomplete.png",
        None,
    )
    .await;
    part(&server, &target_cookie, &pending_owned).await;
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":[owned]}),
            Some(&target_cookie),
        )
        .await
        .value();
    let album = server
        .rpc(
            "photos.createAlbum",
            json!({"name":"private-album"}),
            Some(&target_cookie),
        )
        .await
        .value()["id"]
        .clone();
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":album,"fileIds":[original_id,contributed_id]}),
            Some(&target_cookie),
        )
        .await
        .value();
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":owned,"public":true,"role":"viewer"}),
            Some(&target_cookie),
        )
        .await;
    let token = share.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    server
        .rpc(
            "shares.create",
            json!({"itemId":owned,"public":false,"role":"viewer","recipientId":other}),
            Some(&target_cookie),
        )
        .await
        .value();
    let other_album = server
        .rpc(
            "photos.createAlbum",
            json!({"name":"Other references"}),
            Some(&other_cookie),
        )
        .await
        .value()["id"]
        .clone();
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":other_album,"fileIds":[original_id,contributed_id]}),
            Some(&other_cookie),
        )
        .await
        .value();
    server
        .rpc(
            "admin.createInvite",
            json!({"email":"target@example.test"}),
            Some(&admin_cookie),
        )
        .await
        .value();
    // Historical/volume fixtures exercise bounded credential pruning without issuing fake client grants.
    server.state.db.execute_raw(sql("INSERT INTO hyori_grants(token_digest,share_id,expires_at) SELECT lpad(n::text,64,'0'),$1,now()+interval '1 hour' FROM generate_series(1,300) n",vec![share.value()["id"].as_str().unwrap().into()])).await.unwrap();
    server.state.db.execute_raw(sql("INSERT INTO hyori_invites(token_digest,issuer_id,email,expires_at) VALUES (repeat('a',64),$1,'historical-invite@example.test',now()+interval '1 hour')",vec![target.clone().into()])).await.unwrap();
    // Bulk fixture tests account-only hierarchy deletion beyond ordinary mutation/batch limits.
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids)
        SELECT 'purge_folder_'||n,$1,$2,'private-folder-'||n,'folder','inode/directory',jsonb_build_array($2::text) FROM generate_series(1,600) n",vec![target.clone().into(),owned.clone().into()])).await.unwrap();
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids)
        SELECT 'purge_leaf_'||n,$1,'purge_folder_'||n,'private-leaf-'||n,'file','image/png',jsonb_build_array($2::text,'purge_folder_'||n) FROM generate_series(1,600) n",vec![target.clone().into(),owned.clone().into()])).await.unwrap();
    let object_keys = server
        .state
        .db
        .query_all_raw(sql(
            "SELECT object_key FROM hyori_objects WHERE owner_id=$1",
            vec![target.clone().into()],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.try_get::<String>("", "object_key").unwrap())
        .collect::<Vec<_>>();
    assert_eq!(object_keys.len(), 3);
    let saved_key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_items WHERE id=$1",
            vec![contributed_id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    let direct = ObjectStorage::new(fs.config.clone()).unwrap();
    assert_eq!(direct.head(&saved_key).await.unwrap().size, 101);
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":target,"quotaBytes":0}),
            Some(&admin_cookie),
        )
        .await
        .value();
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":pending_owned}),
            Some(&target_cookie),
        )
        .await
        .error(409, "storage.quotaExceeded");
    server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":"blocked","size":1,"mimeType":""}),
            Some(&target_cookie),
        )
        .await
        .error(409, "storage.quotaExceeded");
    assert_eq!(
        server
            .rpc("files.get", json!({"id":original_id}), Some(&target_cookie))
            .await
            .value()["size"],
        101
    );
    *proxy.faults.allowed_key.lock().unwrap() = object_keys.iter().min().unwrap().clone();
    proxy.faults.mode.store(1, Ordering::SeqCst);
    let (a, b) = tokio::join!(
        server.rpc(
            "admin.deleteUser",
            json!({"userId":target,"confirmEmail":"target@example.test"}),
            Some(&admin_cookie)
        ),
        server.rpc(
            "admin.deleteUser",
            json!({"userId":target,"confirmEmail":"target@example.test"}),
            Some(&admin_cookie)
        )
    );
    assert_eq!(a.value()["state"], "pending");
    assert_eq!(b.value()["state"], "pending");
    for value in [&a.body, &b.body] {
        assert!(!value.to_string().contains("private-"));
        assert!(!value.to_string().contains("owners/"));
    }
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&target_cookie))
            .await
            .value()["user"],
        json!(null)
    );
    server
        .rpc("files.get", json!({"id":original_id}), Some(&grant))
        .await
        .error(401, "auth.required");
    assert_ne!(
        server
            .rpc(
                "uploads.complete",
                json!({"uploadId":pending_contribution}),
                Some(&target_cookie)
            )
            .await
            .status,
        200
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS count FROM hyori_users WHERE id=$1",
            &other
        )
        .await,
        0
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_users WHERE id=$1 AND status='deleting'",
            &target
        )
        .await,
        1
    );
    let mut remaining = 0;
    for key in &object_keys {
        if direct.head(key).await.is_ok() {
            remaining += 1;
        }
    }
    assert_eq!(
        remaining, 2,
        "one actual original was deleted before the storage fault; the rest remain pending"
    );
    proxy.faults.mode.store(0, Ordering::SeqCst);
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    let peer = TestServer::start(pg.config.clone()).await;
    for _ in 0..12 {
        due(&server).await;
        let (a, b) = tokio::join!(purge::reclaim(&server.state), purge::reclaim(&peer.state));
        assert_eq!(
            a.unwrap() + b.unwrap(),
            1,
            "two processes claim a due account only once"
        );
        if scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_users WHERE id=$1 AND status='deleted'",
            &target,
        )
        .await
            == 1
        {
            break;
        }
    }
    assert_eq!(scalar(&server,"SELECT count(*) AS count FROM hyori_users WHERE id=$1 AND status='deleted' AND email='deleted:'||id AND name='Deleted account' AND used_bytes=0 AND reserved_bytes=0 AND quota_bytes=0",&target).await,1);
    for query in [
        "SELECT count(*) AS count FROM hyori_items WHERE owner_id=$1 OR uploaded_by=$1",
        "SELECT count(*) AS count FROM hyori_versions WHERE owner_id=$1",
        "SELECT count(*) AS count FROM hyori_objects WHERE owner_id=$1",
        "SELECT count(*) AS count FROM hyori_credentials WHERE user_id=$1",
        "SELECT count(*) AS count FROM hyori_sessions WHERE user_id=$1",
        "SELECT count(*) AS count FROM hyori_shares WHERE issuer_id=$1 OR recipient_id=$1",
        "SELECT count(*) AS count FROM hyori_invites WHERE issuer_id=$1 OR email='target@example.test'",
        "SELECT count(*) AS count FROM hyori_photo_sources WHERE user_id=$1",
        "SELECT count(*) AS count FROM hyori_photo_albums WHERE owner_id=$1",
    ] {
        assert_eq!(scalar(&server, query, &target).await, 0, "{query}");
    }
    assert_eq!(scalar(&server,"SELECT count(*) AS count FROM hyori_uploads WHERE owner_id=$1 AND (NOT purged OR state<>'aborted' OR reservation_held OR name<>'' OR mime_type<>'' OR uploader_id IS NOT NULL OR result IS NOT NULL OR parent_id IS NOT NULL OR grant_digests<>'[]')",&target).await,0);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_uploads WHERE owner_id=$1 AND purged",
            &target
        )
        .await,
        4
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT deleted_objects AS count FROM hyori_account_purges WHERE user_id=$1",
            &target
        )
        .await,
        3
    );
    for key in &object_keys {
        assert!(direct.head(key).await.is_err());
    }
    assert_eq!(direct.head(&saved_key).await.unwrap().size, 101);
    assert_eq!(
        scalar(
            &server,
            "SELECT used_bytes AS count FROM hyori_users WHERE id=$1",
            &other
        )
        .await,
        101
    );
    assert_eq!(
        server
            .rpc(
                "files.get",
                json!({"id":contributed_id}),
                Some(&other_cookie)
            )
            .await
            .value()["id"],
        contributed_id
    );
    assert_eq!(
        server
            .rpc("photos.albums", json!({}), Some(&other_cookie))
            .await
            .value()["items"][0]["count"],
        1.0
    );
    assert!(
        !server
            .rpc("admin.users", json!({}), Some(&admin_cookie))
            .await
            .value()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["id"] == target)
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_bootstrap WHERE initialized AND admin_id=$1",
            &admin
        )
        .await,
        1
    );
    due(&server).await;
    purge::reclaim(&server.state).await.unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT deleted_objects AS count FROM hyori_account_purges WHERE user_id=$1",
            &target
        )
        .await,
        3
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS late begin and in-flight completion deletion fencing"]
async fn deleted_account_tombstones_reconcile_late_begin_and_fence_publishing_workers() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let proxy = Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = proxy.endpoint.clone();
    pg.config.storage = Some(config);
    let server = TestServer::start(pg.config.clone()).await;
    let (_, admin) = setup(&server).await;
    let direct = ObjectStorage::new(fs.config.clone()).unwrap();
    let (late, cookie) = account(&server, &admin, "late@example.test").await;
    proxy.faults.mode.store(2, Ordering::SeqCst);
    let beginning = server.rpc(
        "uploads.begin",
        json!({"parentId":null,"name":"late-private.png","mimeType":"image/png","size":101}),
        Some(&cookie),
    );
    let deletion = async {
        proxy.faults.reached.notified().await;
        let response = server
            .rpc(
                "admin.deleteUser",
                json!({"userId":late,"confirmEmail":"late@example.test"}),
                Some(&admin),
            )
            .await;
        assert_eq!(response.value()["state"], "complete");
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (response, ()) = tokio::join!(beginning, deletion);
    assert_ne!(response.status, 200);
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE owner_id=$1",
            vec![late.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    assert_eq!(
        direct.unfinished(&key).await.unwrap().uploads.len(),
        1,
        "late storage begin is observable after account completion"
    );
    due(&server).await;
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(direct.unfinished(&key).await.unwrap().uploads.is_empty());
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS count FROM hyori_users WHERE id=$1",
            &late
        )
        .await,
        0
    );
    let (completing, cookie) = account(&server, &admin, "completing@example.test").await;
    let id = begin(&server, &cookie, None, "commit-private.png", None).await;
    part(&server, &cookie, &id).await;
    proxy.faults.mode.store(3, Ordering::SeqCst);
    let completion = server.rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie));
    let deletion = async {
        proxy.faults.reached.notified().await;
        server
            .rpc(
                "admin.deleteUser",
                json!({"userId":completing,"confirmEmail":"completing@example.test"}),
                Some(&admin),
            )
            .await
            .value();
        proxy.faults.mode.store(0, Ordering::SeqCst);
        proxy.faults.release.notify_one();
    };
    let (response, ()) = tokio::join!(completion, deletion);
    assert_ne!(response.status, 200);
    due(&server).await;
    purge::reclaim(&server.state).await.unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS count FROM hyori_items WHERE owner_id=$1",
            &completing
        )
        .await,
        0
    );
    assert_eq!(scalar(&server,"SELECT count(*) AS count FROM hyori_uploads WHERE owner_id=$1 AND state='aborted' AND lease_token IS NULL AND result IS NULL AND name=''",&completing).await,1);
    let key = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT object_key FROM hyori_uploads WHERE owner_id=$1",
            vec![completing.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "object_key")
        .unwrap();
    assert!(direct.head(&key).await.is_err());
    assert_eq!(scalar(&server,"SELECT count(*) AS count FROM hyori_users WHERE id=$1 AND status='deleted' AND reserved_bytes=0 AND used_bytes=0",&completing).await,1);
    pg.stop();
}

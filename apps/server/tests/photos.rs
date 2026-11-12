#[path = "support/storage.rs"]
mod storage;
mod support;
use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use support::{Postgres, TestServer};

async fn setup(server: &TestServer) -> (String, String) {
    let reply = server.rpc("auth.setup",json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    assert!(reply.cookie.is_some());
    (
        reply.value()["id"].as_str().unwrap().into(),
        reply.credential(),
    )
}
async fn upload(server: &TestServer, cookie: &str, name: &str, mime: &str, bytes: &[u8]) -> String {
    let begin = server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":name,"mimeType":mime,"size":bytes.len()}),
            Some(cookie),
        )
        .await;
    let id = begin.value()["uploadId"].as_str().unwrap();
    let response = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn preview(
    server: &TestServer,
    cookie: &str,
    id: &str,
    range: Option<&str>,
) -> reqwest::Response {
    let mut request = server
        .client
        .get(format!("{}/api/storage/previews/{id}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie);
    if let Some(range) = range {
        request = request.header("range", range);
    }
    request.send().await.unwrap()
}
#[tokio::test]
#[ignore = "real PostgreSQL and pinned RustFS original-media HTTP boundary"]
async fn inline_originals_validate_family_ranges_current_object_and_revocation() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let (_, cookie) = setup(&server).await;
    let fixtures: [(&str, &str, &[u8]); 8] = [
        (
            "red.png",
            "image/png",
            include_bytes!("fixtures/media/red.png"),
        ),
        (
            "red.jpg",
            "image/jpeg",
            include_bytes!("fixtures/media/red.jpg"),
        ),
        (
            "red.webp",
            "image/webp",
            include_bytes!("fixtures/media/red.webp"),
        ),
        (
            "red.gif",
            "image/gif",
            include_bytes!("fixtures/media/red.gif"),
        ),
        (
            "red.avif",
            "image/avif",
            include_bytes!("fixtures/media/red.avif"),
        ),
        (
            "red.mp4",
            "video/mp4",
            include_bytes!("fixtures/media/red.mp4"),
        ),
        (
            "red.webm",
            "video/webm",
            include_bytes!("fixtures/media/red.webm"),
        ),
        (
            "red.mov",
            "video/quicktime",
            include_bytes!("fixtures/media/red.mov"),
        ),
    ];
    for (name, mime, bytes) in fixtures {
        let id = upload(&server, &cookie, name, mime, bytes).await;
        let metadata = server
            .rpc("files.preview", json!({"id":id}), Some(&cookie))
            .await;
        assert_eq!(
            metadata.value()["url"],
            format!("/api/storage/previews/{id}?revision=0")
        );
        let response = preview(&server, &cookie, &id, None).await;
        assert_eq!(response.status(), 200, "{name}");
        assert_eq!(response.headers()["content-type"], mime);
        assert_eq!(
            response.headers()["content-length"],
            bytes.len().to_string()
        );
        assert_eq!(response.headers()["cache-control"], "private, no-cache");
        assert!(response.headers().contains_key("etag"));
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(
            response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("sandbox")
        );
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("inline;")
        );
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
        for (range, start, end) in [
            ("bytes=2-7", 2, 7),
            ("bytes=-3", bytes.len() - 3, bytes.len() - 1),
        ] {
            let response = preview(&server, &cookie, &id, Some(range)).await;
            assert_eq!(response.status(), 206);
            assert_eq!(
                response.headers()["content-length"],
                (end - start + 1).to_string()
            );
            assert_eq!(
                response.headers()["content-range"],
                format!("bytes {start}-{end}/{}", bytes.len())
            );
            assert_eq!(
                response.bytes().await.unwrap().as_ref(),
                &bytes[start..=end]
            );
        }
        for range in ["bytes=99999-", "bytes=0-1,4-5", "bytes=-0"] {
            let response = preview(&server, &cookie, &id, Some(range)).await;
            assert_eq!(response.status(), 416);
            assert_eq!(
                response.headers()["content-range"],
                format!("bytes */{}", bytes.len())
            );
            assert_eq!(response.headers()["content-length"], "0");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert!(response.bytes().await.unwrap().is_empty());
        }
    }
    for (name, mime, bytes) in [
        (
            "html.png",
            "image/png",
            b"<!DOCTYPE html><script>alert(1)</script>".as_slice(),
        ),
        ("xml.jpg", "image/jpeg", b"<?xml version='1.0'?><html/>"),
        ("svg.png", "image/png", b"<svg onload='alert(1)'/>"),
        ("unknown.gif", "image/gif", b"unrecognized"),
        (
            "mismatch.jpg",
            "image/jpeg",
            include_bytes!("fixtures/media/red.png").as_slice(),
        ),
        ("pdf.webp", "image/webp", b"%PDF-1.7"),
        ("actual.svg", "image/svg+xml", b"<svg/>"),
    ] {
        let id = upload(&server, &cookie, name, mime, bytes).await;
        assert_eq!(
            preview(&server, &cookie, &id, None).await.status(),
            400,
            "{name}"
        );
        assert_eq!(
            preview(&server, &cookie, &id, Some("bytes=3-5"))
                .await
                .status(),
            400,
            "range cannot skip validation"
        );
        let response = server
            .client
            .get(format!("{}/api/storage/files/{id}", server.url))
            .header("origin", &server.state.config.origin)
            .header("host", "localhost:3001")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.headers()["content-type"],
            "application/octet-stream"
        );
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
    }
    let id = upload(&server, &cookie, "public.png", "image/png", fixtures[0].2).await;
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":id,"role":"viewer","public":true,"password":"preview-password"}),
            Some(&cookie),
        )
        .await;
    let token = share.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    assert_eq!(preview(&server, "", &id, None).await.status(), 403);
    let grant = server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"preview-password"}),
            None,
        )
        .await
        .credential();
    assert_eq!(preview(&server, &grant, &id, None).await.status(), 200);
    server
        .rpc("files.get", json!({"id":id}), Some(&grant))
        .await
        .value();
    server
        .rpc("files.versions", json!({"id":id}), Some(&grant))
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "shares.revoke",
            json!({"id":share.value()["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(preview(&server, &grant, &id, None).await.status(), 403);
    server
        .rpc("files.get", json!({"id":id}), Some(&grant))
        .await
        .error(401, "auth.required");
    server
        .rpc("files.trash", json!({"id":id}), Some(&cookie))
        .await
        .value();
    assert_eq!(preview(&server, &cookie, &id, None).await.status(), 404);
    server
        .rpc("files.get", json!({"id":id}), Some(&cookie))
        .await
        .error(404, "resource.notFound");
    pg.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL Photos policy, deterministic ordering and capacity boundaries"]
async fn personal_sources_albums_scope_reconciliation_and_capacity_are_transactional() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let (admin, admin_cookie) = setup(&server).await;
    let password = random_token();
    let user = server
        .rpc(
            "admin.createUser",
            json!({"email":"user@example.test","name":"User","password":password}),
            Some(&admin_cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":"user@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Pictures"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = server
        .rpc(
            "files.createFolder",
            json!({"parentId":folder,"name":"Child"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Metadata-only bulk fixtures stress exact timestamp ties/caps; the separate SDK harness uploads originals.
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids,created_at)
        SELECT 'media_'||lpad(n::text,4,'0'),$1,$2,'sample_'||n,'file','image/png',$3,'2026-01-01T00:00:00Z' FROM generate_series(1,1001) n",vec![user.clone().into(),child.into(),json!([folder]).into()])).await.unwrap();
    assert_eq!(
        server
            .rpc("photos.timeline", json!({}), Some(&cookie))
            .await
            .value()["items"],
        json!([])
    );
    server
        .rpc("photos.sources", json!({}), None)
        .await
        .error(401, "auth.required");
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":[folder]}),
            Some(&cookie),
        )
        .await
        .value();
    let first = server
        .rpc("photos.timeline", json!({}), Some(&cookie))
        .await;
    assert_eq!(first.value()["items"].as_array().unwrap().len(), 100);
    assert_eq!(first.value()["items"][0]["id"], "media_1001");
    assert_eq!(first.value()["items"][99]["id"], "media_0902");
    let second = server
        .rpc(
            "photos.timeline",
            json!({"cursor":first.value()["nextCursor"]}),
            Some(&cookie),
        )
        .await;
    assert_eq!(second.value()["items"][0]["id"], "media_0901");
    server
        .rpc(
            "photos.timeline",
            json!({"cursor":"invalid"}),
            Some(&cookie),
        )
        .await
        .error(400, "input.invalid");
    let denied = server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":true,"folderIds":[folder,"missing"]}),
            Some(&admin_cookie),
        )
        .await;
    assert_eq!(denied.value(), &json!({"allMyFiles":true,"folderIds":[]}));
    assert_eq!(
        server
            .rpc("photos.timeline", json!({}), Some(&admin_cookie))
            .await
            .value()["items"],
        json!([])
    );
    server
        .rpc("files.get", json!({"id":"media_1001"}), Some(&admin_cookie))
        .await
        .error(403, "access.denied");
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"recipientId":admin,"role":"viewer","public":false}),
            Some(&cookie),
        )
        .await;
    // All my files does not absorb even currently shared libraries.
    assert_eq!(
        server
            .rpc("photos.timeline", json!({}), Some(&admin_cookie))
            .await
            .value()["items"],
        json!([])
    );
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":[folder]}),
            Some(&admin_cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("photos.timeline", json!({}), Some(&admin_cookie))
            .await
            .value()["items"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    let album = server
        .rpc(
            "photos.createAlbum",
            json!({"name":"Personal"}),
            Some(&admin_cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":album,"fileIds":["media_1001","media_1001"]}),
            Some(&admin_cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("photos.albums", json!({}), Some(&admin_cookie))
            .await
            .value()["items"][0]["count"],
        1.0
    );
    assert_eq!(
        server
            .rpc("photos.albums", json!({}), Some(&cookie))
            .await
            .value()["items"],
        json!([])
    );
    server
        .rpc("photos.timeline", json!({"albumId":album}), Some(&cookie))
        .await
        .error(404, "resource.notFound");
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":album,"fileIds":["missing"]}),
            Some(&cookie),
        )
        .await
        .error(404, "resource.notFound");
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":[]}),
            Some(&admin_cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc(
                "photos.timeline",
                json!({"albumId":album}),
                Some(&admin_cookie)
            )
            .await
            .value()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    server
        .rpc("files.get", json!({"id":"media_1001"}), Some(&cookie))
        .await
        .value();
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":[folder]}),
            Some(&admin_cookie),
        )
        .await
        .value();
    server
        .rpc(
            "shares.revoke",
            json!({"id":share.value()["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("photos.sources", json!({}), Some(&admin_cookie))
            .await
            .value()["folderIds"],
        json!([])
    );
    assert_eq!(
        server
            .rpc(
                "photos.timeline",
                json!({"albumId":album}),
                Some(&admin_cookie)
            )
            .await
            .value()["items"],
        json!([])
    );
    assert_eq!(
        server
            .rpc("photos.albums", json!({}), Some(&admin_cookie))
            .await
            .value()["items"][0]["count"],
        1.0
    );
    for id in ["missing", "media_1001", &folder] {
        server
            .rpc(
                "photos.addToAlbum",
                json!({"albumId":album,"fileIds":[id]}),
                Some(&admin_cookie),
            )
            .await
            .error(404, "resource.notFound");
    }
    // No descendant cap: the whole 1,001-item subtree leaves the timeline, then comes back.
    server
        .rpc("files.trash", json!({"id":folder}), Some(&cookie))
        .await
        .value();
    let hidden = server
        .rpc("photos.timeline", json!({}), Some(&cookie))
        .await;
    assert!(
        hidden.value()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| !item["id"].as_str().unwrap().starts_with("media_"))
    );
    server
        .rpc("files.restore", json!({"id":folder}), Some(&cookie))
        .await
        .value();
    server
        .rpc("files.trash", json!({"id":"media_1001"}), Some(&cookie))
        .await
        .value();
    assert_eq!(
        server
            .rpc("photos.timeline", json!({}), Some(&cookie))
            .await
            .value()["items"][0]["id"],
        "media_1000"
    );
    let own_album = server
        .rpc(
            "photos.createAlbum",
            json!({"name":"Capacity"}),
            Some(&cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.state.db.execute_raw(sql("INSERT INTO hyori_photo_album_items(album_id,file_id) SELECT $1,'media_'||lpad(n::text,4,'0') FROM generate_series(1,999) n",vec![own_album.clone().into()])).await.unwrap();
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":own_album,"fileIds":["media_1000"]}),
            Some(&cookie),
        )
        .await
        .value();
    server
        .rpc("files.restore", json!({"id":"media_1001"}), Some(&cookie))
        .await
        .value();
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":own_album,"fileIds":["media_1001"]}),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":own_album,"fileIds":["media_1000"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("photos.albums", json!({}), Some(&cookie))
            .await
            .value()["items"][0]["count"],
        1000.0
    );
    server.state.db.execute_raw(sql("INSERT INTO hyori_photo_albums(id,owner_id,name) SELECT 'album_'||n,$1,'Album '||n FROM generate_series(1,99) n",vec![user.into()])).await.unwrap();
    server
        .rpc(
            "photos.createAlbum",
            json!({"name":"Overflow"}),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":false,"folderIds":vec!["missing";101]}),
            Some(&cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "photos.addToAlbum",
            json!({"albumId":own_album,"fileIds":vec!["media_1000";101]}),
            Some(&cookie),
        )
        .await
        .error(400, "input.invalid");
    pg.stop();
}

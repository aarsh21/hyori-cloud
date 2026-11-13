use super::{PDF, PDF_EDIT, enable, finish, input, open, prepare, put, scalar, setup, upload};
use serde_json::json;

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS Viewer copy destination and replay authorization"]
async fn viewer_copies_require_explicit_writable_destination_and_current_source_access() {
    let (pg, _fs, server, _owner, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "read-only.pdf", PDF, None).await;
    let viewer=server.rpc("admin.createUser",json!({"email":"viewer-copy@example.test","name":"Viewer","password":"long-test-password-for-viewer-copy"}),Some(&owner)).await.value().clone();
    let viewer_cookie=server.rpc("auth.login",json!({"email":"viewer-copy@example.test","password":"long-test-password-for-viewer-copy"}),None).await.credential();
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":file["id"],"public":false,"recipientId":viewer["id"],"role":"viewer"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let document = open(&server, &viewer_cookie, &file).await;
    assert_eq!(document["writable"], false);
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "replace-denied", PDF_EDIT),
            Some(&viewer_cookie),
        )
        .await
        .error(403, "access.denied");
    let mut copy = input(&document, "viewer-copy", PDF_EDIT);
    copy["intent"] = json!("save-as");
    copy["name"] = json!("my-copy.pdf");
    server
        .rpc("editors.prepareSave", copy.clone(), Some(&viewer_cookie))
        .await
        .error(400, "input.invalid");
    let private = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Private destination"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    copy["destination"] = json!({"parentId":private["id"]});
    server
        .rpc("editors.prepareSave", copy.clone(), Some(&viewer_cookie))
        .await
        .error(403, "access.denied");
    copy["destination"] = json!({"parentId":null});
    let id = prepare(&server, &viewer_cookie, copy).await;
    assert_eq!(
        put(&server, &viewer_cookie, &id, PDF_EDIT).await.status(),
        200
    );
    let saved = server
        .rpc(
            "uploads.complete",
            json!({"uploadId":id}),
            Some(&viewer_cookie),
        )
        .await
        .value()
        .clone();
    assert_ne!(saved["id"], file["id"]);
    assert_eq!(saved["ownerId"], viewer["id"]);
    assert_eq!(
        finish(&server, &viewer_cookie, &document, "viewer-copy").await["revision"],
        document["revision"]
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        0
    );
    let word_bytes = super::formats::archive(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", b"<document/>"),
    ]);
    let word = upload(&server, &owner, "read-only.docx", &word_bytes, None).await;
    server
        .rpc(
            "shares.create",
            json!({"itemId":word["id"],"public":false,"recipientId":viewer["id"],"role":"viewer"}),
            Some(&owner),
        )
        .await
        .value();
    let word_document = open(&server, &viewer_cookie, &word).await;
    assert_eq!(word_document["writable"], false);
    let mut export = input(&word_document, "viewer-export", PDF);
    export["intent"] = json!("export");
    export["name"] = json!("word-export.pdf");
    export["destination"] = json!({"parentId":null});
    let exported = prepare(&server, &viewer_cookie, export).await;
    assert_eq!(
        put(&server, &viewer_cookie, &exported, PDF).await.status(),
        200
    );
    assert_eq!(
        finish(&server, &viewer_cookie, &word_document, "viewer-export").await["revision"],
        word_document["revision"]
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            word["id"].as_str().unwrap()
        )
        .await,
        0
    );
    let mut pending = input(&document, "revoked-before-publication", PDF);
    pending["intent"] = json!("save-as");
    pending["name"] = json!("other-copy.pdf");
    pending["destination"] = json!({"parentId":null});
    let pending = prepare(&server, &viewer_cookie, pending).await;
    assert_eq!(
        put(&server, &viewer_cookie, &pending, PDF).await.status(),
        200
    );
    server
        .rpc("shares.revoke", json!({"id":share["id"]}), Some(&owner))
        .await
        .value();
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":pending}),
            Some(&viewer_cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":id}),
            Some(&viewer_cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":document["sessionId"],"saveId":"viewer-copy"}),
            Some(&viewer_cookie),
        )
        .await
        .error(403, "access.denied");
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS anonymous Viewer copy requires a separate Contributor grant"]
async fn anonymous_viewer_copy_cannot_invent_root_or_destination_authority() {
    let (pg, _fs, server, _owner, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "public-read.pdf", PDF, None).await;
    let source = server
        .rpc(
            "shares.create",
            json!({"itemId":file["id"],"public":true,"role":"viewer"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let source_token = source["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let source_cookie = server
        .rpc("shares.resolve", json!({"token":source_token}), None)
        .await
        .credential();
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Contributed copies"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let document = open(&server, &source_cookie, &file).await;
    assert!(document.get("annotationAuthor").is_none());
    let mut copy = input(&document, "anonymous-copy", PDF_EDIT);
    copy["intent"] = json!("save-as");
    copy["name"] = json!("anonymous-copy.pdf");
    copy["destination"] = json!({"parentId":null});
    server
        .rpc("editors.prepareSave", copy.clone(), Some(&source_cookie))
        .await
        .error(401, "auth.required");
    copy["destination"] = json!({"parentId":folder["id"]});
    server
        .rpc("editors.prepareSave", copy.clone(), Some(&source_cookie))
        .await
        .error(403, "access.denied");
    let destination = server
        .rpc(
            "shares.create",
            json!({"itemId":folder["id"],"public":true,"role":"contributor"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let destination_token = destination["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let destination_cookie = server
        .rpc(
            "shares.resolve",
            json!({"token":destination_token}),
            Some(&source_cookie),
        )
        .await
        .credential();
    let both = format!("{source_cookie}; {destination_cookie}");
    let id = prepare(&server, &both, copy.clone()).await;
    server
        .rpc(
            "shares.revoke",
            json!({"id":destination["id"]}),
            Some(&owner),
        )
        .await
        .value();
    assert_eq!(put(&server, &both, &id, PDF_EDIT).await.status(), 403);
    server
        .rpc("uploads.abort", json!({"uploadId":id}), Some(&both))
        .await
        .value();
    let destination = server
        .rpc(
            "shares.create",
            json!({"itemId":folder["id"],"public":true,"role":"contributor"}),
            Some(&owner),
        )
        .await
        .value()
        .clone();
    let token = destination["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let granted = server
        .rpc(
            "shares.resolve",
            json!({"token":token}),
            Some(&source_cookie),
        )
        .await
        .credential();
    let both = format!("{source_cookie}; {granted}");
    copy["saveId"] = json!("anonymous-second");
    let id = prepare(&server, &both, copy).await;
    assert_eq!(put(&server, &both, &id, PDF_EDIT).await.status(), 200);
    let saved = finish(&server, &both, &document, "anonymous-second").await;
    assert_eq!(saved["file"]["ownerId"], file["ownerId"]);
    assert_eq!(saved["revision"], document["revision"]);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        0
    );
    pg.stop();
}

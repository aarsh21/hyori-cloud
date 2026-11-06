use crate::{
    storage,
    support::{Postgres, TestServer},
};
use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[path = "editor_assets_fixture.rs"]
mod assets;

struct EditorPostgres {
    pg: Postgres,
    _assets: assets::BundleFixture,
}
impl std::ops::Deref for EditorPostgres {
    type Target = Postgres;
    fn deref(&self) -> &Postgres {
        &self.pg
    }
}
impl std::ops::DerefMut for EditorPostgres {
    fn deref_mut(&mut self) -> &mut Postgres {
        &mut self.pg
    }
}

#[path = "editor_automatic.rs"]
mod automatic;
#[path = "editor_close.rs"]
mod close;
#[path = "editor_fault_cases.rs"]
mod fault_cases;
#[path = "editor_storage_proxy.rs"]
mod fault_proxy;
#[path = "editor_formats.rs"]
mod formats;
#[path = "editor_gc.rs"]
mod gc;
#[path = "editor_readonly.rs"]
mod readonly;

const PDF: &[u8] = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const PDF_EDIT: &[u8] =
    b"%PDF-1.7\n1 0 obj<</Type/Catalog /Lang(en)>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

async fn setup() -> (EditorPostgres, storage::RustFs, TestServer, String, String) {
    let mut pg = Postgres::start().await;
    let assets = assets::BundleFixture::new();
    pg.config.editor_assets = Some(assets.persist());
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let reply=server.rpc("auth.setup",json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}),None).await;
    assert!(reply.cookie.is_some());
    let owner = reply.value()["id"].as_str().unwrap().to_owned();
    let cookie = reply.credential();
    (
        EditorPostgres {
            pg,
            _assets: assets,
        },
        fs,
        server,
        owner,
        cookie,
    )
}
async fn enable(server: &TestServer) {
    // Private synthetic persistence fixture, never a runtime/legal approval or deployed editor asset.
    server
        .state
        .db
        .execute_raw(sql("UPDATE hyori_editor_assets SET enabled=true", vec![]))
        .await
        .unwrap();
}
async fn put(server: &TestServer, cookie: &str, id: &str, bytes: &[u8]) -> reqwest::Response {
    server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .header("content-length", bytes.len())
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap()
}
async fn upload(
    server: &TestServer,
    cookie: &str,
    name: &str,
    bytes: &[u8],
    parent: Option<&str>,
) -> Value {
    let reply=server.rpc("uploads.begin",json!({"parentId":parent,"name":name,"size":bytes.len(),"mimeType":"application/octet-stream"}),Some(cookie)).await;
    let id = reply.value()["uploadId"].as_str().unwrap();
    assert_eq!(put(server, cookie, id, bytes).await.status(), 200);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()
        .clone()
}
async fn open(server: &TestServer, cookie: &str, file: &Value) -> Value {
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(cookie))
        .await
        .value()
        .clone()
}
fn input(document: &Value, id: &str, bytes: &[u8]) -> Value {
    json!({"sessionId":document["sessionId"],"saveId":id,"expectedRevision":document["revision"],"name":document["name"],"size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes)),"intent":"replace"})
}
async fn prepare(server: &TestServer, cookie: &str, input: Value) -> String {
    server
        .rpc("editors.prepareSave", input, Some(cookie))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .into()
}
async fn finish(server: &TestServer, cookie: &str, document: &Value, id: &str) -> Value {
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":document["sessionId"],"saveId":id}),
            Some(cookie),
        )
        .await
        .value()
        .clone()
}
async fn descriptor(server: &TestServer, cookie: &str, document: &Value) -> Value {
    server
        .rpc(
            "editors.download",
            json!({"sessionId":document["sessionId"],"expectedRevision":document["revision"]}),
            Some(cookie),
        )
        .await
        .value()
        .clone()
}
async fn get(server: &TestServer, cookie: &str, url: &str) -> reqwest::Response {
    server
        .client
        .get(format!("{}{url}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .send()
        .await
        .unwrap()
}
async fn scalar(server: &TestServer, query: &str, id: &str) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(query, vec![id.into()]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap()
}

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS editor HTTP lifecycle"]
async fn opened_revision_conflicts_publication_replay_restart_and_explicit_copy() {
    let (pg, _fs, mut server, owner, cookie) = setup().await;
    let file = upload(&server, &cookie, "draft.pdf", PDF, None).await;
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .error(503, "service.unavailable");
    enable(&server).await;
    let mut first = open(&server, &cookie, &file).await;
    let second = open(&server, &cookie, &file).await;
    let old_url = descriptor(&server, &cookie, &first).await["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let downloaded = get(&server, &cookie, &old_url).await;
    assert_eq!(downloaded.status(), 200);
    assert_eq!(downloaded.bytes().await.unwrap().as_ref(), PDF);
    let a = input(&first, "open-uuid:1", PDF_EDIT);
    let b = input(&second, "competing", PDF_EDIT);
    let ua = prepare(&server, &cookie, a.clone()).await;
    let ub = prepare(&server, &cookie, b.clone()).await;
    assert_eq!(prepare(&server, &cookie, a.clone()).await, ua);
    assert_eq!(put(&server, &cookie, &ua, PDF_EDIT).await.status(), 200);
    assert_eq!(put(&server, &cookie, &ub, PDF_EDIT).await.status(), 200);
    // Direct generic completion must execute the same editor publication hooks.
    server
        .rpc("uploads.complete", json!({"uploadId":ua}), Some(&cookie))
        .await
        .value();
    server
        .rpc("uploads.complete", json!({"uploadId":ub}), Some(&cookie))
        .await
        .error(409, "resource.conflict");
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    let saved = finish(&server, &cookie, &first, "open-uuid:1").await;
    assert_eq!(saved["revision"], "1");
    assert_eq!(prepare(&server, &cookie, a.clone()).await, ua);
    assert_eq!(finish(&server, &cookie, &first, "open-uuid:1").await, saved);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        1
    );
    assert_eq!(get(&server, &cookie, &old_url).await.status(), 409);
    server
        .rpc(
            "editors.prepareSave",
            input(&second, "stale-new", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    let mut altered = a.clone();
    altered["sha256"] = json!("0".repeat(64));
    server
        .rpc("editors.prepareSave", altered, Some(&cookie))
        .await
        .error(400, "input.invalid");
    first["revision"] = saved["revision"].clone();
    let mut copy = input(&first, "copy", PDF_EDIT);
    copy["intent"] = json!("save-as");
    copy["name"] = json!("copy.pdf");
    server
        .rpc("editors.prepareSave", copy.clone(), Some(&cookie))
        .await
        .error(400, "input.invalid");
    copy["destination"] = json!({"parentId":null});
    let uc = prepare(&server, &cookie, copy).await;
    assert_eq!(put(&server, &cookie, &uc, PDF_EDIT).await.status(), 200);
    let copied = finish(&server, &cookie, &first, "copy").await;
    assert_ne!(copied["file"]["id"], file["id"]);
    assert_eq!(copied["revision"], saved["revision"]);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            file["id"].as_str().unwrap()
        )
        .await,
        1
    );
    let next = prepare(&server, &cookie, input(&first, "next", PDF)).await;
    assert_eq!(put(&server, &cookie, &next, PDF).await.status(), 200);
    let newer = finish(&server, &cookie, &first, "next").await;
    assert_eq!(newer["revision"], "2");
    assert_eq!(
        finish(&server, &cookie, &first, "open-uuid:1").await["revision"],
        "1"
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT revision AS n FROM hyori_editor_sessions WHERE id=$1",
            first["sessionId"].as_str().unwrap()
        )
        .await,
        2
    );
    server
        .rpc("uploads.abort", json!({"uploadId":ub}), Some(&cookie))
        .await
        .value();
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
#[ignore = "disposable real PostgreSQL/RustFS editor authorization"]
async fn direct_editor_public_grant_identity_viewer_downgrade_revocation_and_asset_gate() {
    let (pg, _fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Private"}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let file = upload(&server, &cookie, "direct.pdf", PDF, folder["id"].as_str()).await;
    let recipient=server.rpc("admin.createUser",json!({"email":"editor@example.test","name":"Editor","password":"long-test-password-for-editor"}),Some(&cookie)).await.value().clone();
    let auth = server
        .rpc(
            "auth.login",
            json!({"email":"editor@example.test","password":"long-test-password-for-editor"}),
            None,
        )
        .await;
    let editor = auth.credential();
    let share=server.rpc("shares.create",json!({"itemId":file["id"],"recipientId":recipient["id"],"public":false,"role":"editor"}),Some(&cookie)).await.value().clone();
    server
        .rpc("files.get", json!({"id":folder["id"]}), Some(&editor))
        .await
        .error(403, "access.denied");
    let document = open(&server, &editor, &file).await;
    let id = prepare(&server, &editor, input(&document, "direct", PDF_EDIT)).await;
    assert_eq!(put(&server, &editor, &id, PDF_EDIT).await.status(), 200);
    finish(&server, &editor, &document, "direct").await;
    server
        .rpc("files.versions", json!({"id":file["id"]}), Some(&editor))
        .await
        .error(403, "access.denied");
    server
        .rpc("shares.revoke", json!({"id":share["id"]}), Some(&cookie))
        .await
        .value();
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":document["sessionId"],"saveId":"direct"}),
            Some(&editor),
        )
        .await
        .error(403, "access.denied");
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":file["id"],"public":true,"role":"editor"}),
            Some(&cookie),
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
    let public = open(&server, &holder, &file).await;
    server
        .rpc(
            "editors.download",
            json!({"sessionId":public["sessionId"],"expectedRevision":public["revision"]}),
            Some(&other),
        )
        .await
        .error(403, "access.denied");
    let stable = server
        .rpc("shares.resolve", json!({"token":token}), Some(&holder))
        .await
        .credential();
    descriptor(&server, &stable, &public).await;
    let pending = prepare(&server, &holder, input(&public, "public", PDF)).await;
    assert_eq!(put(&server, &other, &pending, PDF).await.status(), 403);
    assert_eq!(put(&server, &holder, &pending, PDF).await.status(), 200);
    // Simulates an owner downgrade through persisted policy; the public API currently has revoke, not role update.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET role='viewer' WHERE id=$1",
            vec![link["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "uploads.complete",
            json!({"uploadId":pending}),
            Some(&holder),
        )
        .await
        .error(403, "access.denied");
    let viewer = open(&server, &holder, &file).await;
    assert_eq!(viewer["writable"], false);
    server
        .rpc(
            "editors.prepareSave",
            input(&viewer, "no-write", PDF),
            Some(&holder),
        )
        .await
        .error(403, "access.denied");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET role='editor' WHERE id=$1",
            vec![link["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    finish(&server, &holder, &public, "public").await;
    server
        .rpc("shares.revoke", json!({"id":link["id"]}), Some(&cookie))
        .await
        .value();
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":public["sessionId"],"saveId":"public"}),
            Some(&holder),
        )
        .await
        .error(403, "access.denied");
    let owner_doc = open(&server, &cookie, &file).await;
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET enabled=false WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "editors.download",
            json!({"sessionId":owner_doc["sessionId"],"expectedRevision":owner_doc["revision"]}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET enabled=true,version='wrong' WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .error(503, "service.unavailable");
    // Selected-current metadata is not a revocation of a still-included bound engine version.
    let retained = prepare(&server, &cookie, input(&owner_doc, "retained-version", PDF)).await;
    server
        .rpc("uploads.abort", json!({"uploadId":retained}), Some(&cookie))
        .await
        .value();
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS editor validation and retention"]
async fn digest_mismatch_part_replay_quota_expiry_and_bounded_sensitive_retention() {
    let (pg, _fs, server, owner, cookie) = setup().await;
    enable(&server).await;
    let file = upload(&server, &cookie, "input.pdf", PDF, None).await;
    let document = open(&server, &cookie, &file).await;
    let id = prepare(&server, &cookie, input(&document, "wrong-bytes", PDF_EDIT)).await;
    let bad = vec![b'x'; PDF_EDIT.len()];
    assert_eq!(put(&server, &cookie, &id, &bad).await.status(), 200);
    assert_eq!(put(&server, &cookie, &id, PDF_EDIT).await.status(), 400);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(&cookie))
        .await
        .error(400, "input.invalid");
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS n FROM hyori_users WHERE id=$1",
            &owner
        )
        .await,
        0
    );
    let descriptor = descriptor(&server, &cookie, &document).await;
    assert_eq!(
        get(&server, &cookie, descriptor["url"].as_str().unwrap())
            .await
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        PDF
    );
    let spoof = b"<html>not a PDF</html>";
    let id = prepare(&server, &cookie, input(&document, "spoof", spoof)).await;
    assert_eq!(put(&server, &cookie, &id, spoof).await.status(), 200);
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":document["sessionId"],"saveId":"spoof"}),
            Some(&cookie),
        )
        .await
        .error(400, "input.invalid");
    let mut empty = input(&document, "empty", b"");
    server
        .rpc("editors.prepareSave", empty.clone(), Some(&cookie))
        .await
        .error(400, "input.invalid");
    empty["size"] = json!(32 * 1024 * 1024 + 1);
    server
        .rpc("editors.prepareSave", empty, Some(&cookie))
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":owner,"quotaBytes":PDF.len()}),
            Some(&cookie),
        )
        .await
        .value();
    server
        .rpc(
            "editors.prepareSave",
            input(&document, "quota", PDF_EDIT),
            Some(&cookie),
        )
        .await
        .error(409, "storage.quotaExceeded");
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":owner,"quotaBytes":100000}),
            Some(&cookie),
        )
        .await
        .value();
    let pending = prepare(&server, &cookie, input(&document, "expired", PDF_EDIT)).await;
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
            vec![document["sessionId"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        put(&server, &cookie, &pending, PDF_EDIT).await.status(),
        404
    );
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE id=$1",
            document["sessionId"].as_str().unwrap()
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
    server
        .rpc("uploads.status", json!({"uploadId":pending}), Some(&cookie))
        .await
        .error(404, "resource.notFound");
    for _ in 0..32 {
        open(&server, &cookie, &file).await;
    }
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .error(409, "resource.conflict");
    server.state.db.execute_raw(sql("UPDATE hyori_editor_sessions SET expires_at=now()-interval '1 second' WHERE owner_id=$1",vec![owner.clone().into()])).await.unwrap();
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    // Bulk retention fixture only; lifecycle coverage above uses public upload/editor operations.
    server.state.db.execute_raw(sql("INSERT INTO hyori_editor_sessions(id,file_id,owner_id,initiator_id,grant_digests,principal,app,version,revision,name,expires_at) SELECT 'expired-'||n,$1,$2,$2,'[]','bulk','pdfcraft','0.17.0',0,'input.pdf',now()-interval '1 day' FROM generate_series(1,300) n",vec![file["id"].as_str().unwrap().into(),owner.clone().into()])).await.unwrap();
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner
        )
        .await,
        44
    );
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1",
            &owner
        )
        .await,
        0
    );
    pg.stop();
}

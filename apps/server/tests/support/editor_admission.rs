use super::{
    PDF, PDF_EDIT, TestServer, descriptor, enable, finish, input, open, prepare, put, scalar,
    setup, upload,
};
use hyori_server::db::sql;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};

async fn public_link(
    server: &TestServer,
    owner: &str,
    file: &Value,
    role: &str,
) -> (Value, String) {
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":file["id"],"public":true,"role":role}),
            Some(owner),
        )
        .await
        .value()
        .clone();
    let token = link["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    (link, token)
}
async fn holder(server: &TestServer, token: &str) -> String {
    server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential()
}
async fn anonymous_sessions(server: &TestServer, owner_id: &str) -> i64 {
    scalar(
        server,
        "SELECT count(*) AS n FROM hyori_editor_sessions WHERE owner_id=$1 AND initiator_id IS NULL",
        owner_id,
    )
    .await
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS editor admission under public-link load"]
async fn link_sessions_cannot_lock_out_owner_or_collaborators_and_pending_saves_survive() {
    let (pg, _fs, server, owner_id, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "crowded.pdf", PDF, None).await;
    let recipient=server.rpc("admin.createUser",json!({"email":"crowd-editor@example.test","name":"Collaborator","password":"long-test-password-for-crowd-editor"}),Some(&owner)).await.value().clone();
    let collaborator=server.rpc("auth.login",json!({"email":"crowd-editor@example.test","password":"long-test-password-for-crowd-editor"}),None).await.credential();
    server.rpc("shares.create",json!({"itemId":file["id"],"recipientId":recipient["id"],"public":false,"role":"editor"}),Some(&owner)).await.value();
    let (_, token) = public_link(&server, &owner, &file, "editor").await;
    let mut holders = Vec::new();
    for _ in 0..8 {
        holders.push(holder(&server, &token).await);
    }
    // The oldest anonymous session has an unfinished save; eviction must never take it.
    let pending = open(&server, &holders[0], &file).await;
    let pending_upload = prepare(&server, &holders[0], input(&pending, "pending", PDF_EDIT)).await;
    let mut idle = Vec::new();
    for (index, credential) in holders.iter().enumerate() {
        for _ in 0..if index == 0 { 31 } else { 32 } {
            idle.push((credential.clone(), open(&server, credential, &file).await));
        }
    }
    // Eight issued grants holding 32 sessions each previously filled the owner's whole budget.
    let owned = open(&server, &owner, &file).await;
    let shared = open(&server, &collaborator, &file).await;
    assert_eq!(owned["name"], "crowded.pdf");
    assert_eq!(shared["name"], "crowded.pdf");
    assert!(anonymous_sessions(&server, &owner_id).await <= 128);
    // Oldest idle sessions were evicted first; the newest anonymous session is still usable.
    let (first_holder, first) = &idle[0];
    server
        .rpc(
            "editors.download",
            json!({"sessionId":first["sessionId"],"expectedRevision":first["revision"]}),
            Some(first_holder),
        )
        .await
        .error(404, "resource.notFound");
    let (last_holder, last) = idle.last().unwrap();
    assert!(descriptor(&server, last_holder, last).await["url"].is_string());
    assert_eq!(
        put(&server, &holders[0], &pending_upload, PDF_EDIT)
            .await
            .status(),
        200
    );
    assert_eq!(
        finish(&server, &holders[0], &pending, "pending").await["revision"],
        "1"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS editor sessions end with their public link"]
async fn revoked_or_expired_link_sessions_release_admission_and_end() {
    let (pg, _fs, server, owner_id, owner) = setup().await;
    enable(&server).await;
    let file = upload(&server, &owner, "linked.pdf", PDF, None).await;
    let (revoked, revoked_token) = public_link(&server, &owner, &file, "editor").await;
    let (expired, expired_token) = public_link(&server, &owner, &file, "viewer").await;
    let editor = holder(&server, &revoked_token).await;
    let viewer = holder(&server, &expired_token).await;
    let saving = open(&server, &editor, &file).await;
    let upload_id = prepare(&server, &editor, input(&saving, "unfinished", PDF_EDIT)).await;
    open(&server, &editor, &file).await;
    open(&server, &viewer, &file).await;
    open(&server, &viewer, &file).await;
    assert_eq!(anonymous_sessions(&server, &owner_id).await, 4);
    server
        .rpc("shares.revoke", json!({"id":revoked["id"]}), Some(&owner))
        .await
        .value();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_sessions SET link_expires_at=now() WHERE link_shares ? $1",
            vec![expired["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    // The next admission for this owner drops dead link sessions that have no unfinished save.
    open(&server, &owner, &file).await;
    assert_eq!(anonymous_sessions(&server, &owner_id).await, 1);
    // Maintenance ends the remaining dead session, aborting its save so the reservation is freed.
    hyori_server::features::editors::cleanup::run_once(&server.state.db)
        .await
        .unwrap();
    assert_eq!(anonymous_sessions(&server, &owner_id).await, 0);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_uploads WHERE id=$1 AND state='aborted'",
            &upload_id
        )
        .await,
        1
    );
    pg.stop();
}

#[path = "support/storage.rs"]
mod storage;
mod support;

use hyori_server::{auth::random_token, db::sql, features::uploads::cleanup};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, TestServer};

async fn begin(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    size: u64,
) -> support::Reply {
    let name = format!("{}.bin", &random_token()[..12]);
    server
        .rpc(
            "uploads.begin",
            json!({"parentId":parent,"name":name,"size":size,"mimeType":"application/octet-stream"}),
            Some(cookie),
        )
        .await
}
fn id(reply: &support::Reply) -> String {
    reply.value()["uploadId"].as_str().unwrap().to_owned()
}
async fn put(server: &TestServer, cookie: &str, id: &str, bytes: &[u8]) -> reqwest::Response {
    server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(bytes.to_vec())
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
        .try_get::<i64>("", "value")
        .unwrap()
}
async fn execute(server: &TestServer, query: &str, id: &str) {
    server
        .state
        .db
        .execute_raw(sql(query, vec![id.into()]))
        .await
        .unwrap();
}
/// Seconds until the upload's reservation lapses.
async fn remaining(server: &TestServer, id: &str) -> i64 {
    scalar(
        server,
        "SELECT extract(epoch FROM expires_at-now())::bigint AS value FROM hyori_uploads WHERE id=$1",
        id,
    )
    .await
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS contribution reservation expiry, caps and owner cancellation"]
async fn contributions_expire_without_parts_are_capped_per_initiator_and_owner_cancellable() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":server.state.config.setup_token}), None).await;
    assert!(setup.cookie.is_some());
    let owner = setup.credential();
    let owner_id = setup.value()["id"].as_str().unwrap().to_owned();
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":"stranger@example.test","name":"Stranger","password":password}),
            Some(&owner),
        )
        .await
        .value();
    let stranger = server
        .rpc(
            "auth.login",
            json!({"email":"stranger@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"drop"}),
            Some(&owner),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"contributor","public":true}),
            Some(&owner),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    let visitor = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();

    // The owner's own upload lapses after 24 hours without a part; a contribution within the hour.
    let own = id(&begin(&server, &owner, None, 3).await);
    let left = remaining(&server, &own).await;
    assert!((86_300..=86_400).contains(&left), "{left}");
    let contribution = id(&begin(&server, &visitor, Some(&folder), 3).await);
    let left = remaining(&server, &contribution).await;
    assert!((3500..=3600).contains(&left), "{left}");

    // Each part pushes the deadline out again (capped at seven days from creation).
    execute(
        &server,
        "UPDATE hyori_uploads SET expires_at=now()+interval '1 minute' WHERE id=$1",
        &contribution,
    )
    .await;
    let acknowledged = put(&server, &visitor, &contribution, b"abc").await;
    assert_eq!(acknowledged.status(), 200);
    // A part PUT acknowledges only that part, never the whole part list.
    assert_eq!(
        acknowledged.json::<Value>().await.unwrap(),
        json!({"ok":true,"value":{"partNumber":1,"size":3}})
    );
    assert!(remaining(&server, &contribution).await > 3500);

    // A contribution that stops receiving parts is aborted by cleanup and frees the quota.
    let idle = id(&begin(&server, &visitor, Some(&folder), 5).await);
    execute(
        &server,
        "UPDATE hyori_uploads SET expires_at=now()-interval '1 second',cleanup_due=now() WHERE id=$1",
        &idle,
    )
    .await;
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(
        scalar(
            &server,
            "SELECT (state='aborted')::int::bigint AS value FROM hyori_uploads WHERE id=$1",
            &idle
        )
        .await,
        1
    );
    assert_eq!(
        scalar(
            &server,
            "SELECT reserved_bytes AS value FROM hyori_users WHERE id=$1",
            &owner_id
        )
        .await,
        6,
        "only the owner's 3-byte and the live 3-byte contribution remain reserved"
    );

    // One public link's visitors share a pending-upload budget in the owner's space.
    let mut pending = vec![contribution.clone()];
    for _ in 1..16 {
        pending.push(id(&begin(&server, &visitor, Some(&folder), 1).await));
    }
    let another = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    begin(&server, &another, Some(&folder), 1)
        .await
        .error(409, "storage.quotaExceeded");
    // The owner sees and cancels contributions; a stranger cannot.
    let incoming = server
        .rpc("uploads.incoming", json!({}), Some(&owner))
        .await;
    let listed = incoming.value()["items"].as_array().unwrap();
    assert_eq!(listed.len(), 16);
    assert!(listed.iter().all(|item| item["anonymous"] == true));
    assert!(listed.iter().all(|item| item["uploadId"] != own.as_str()));
    server
        .rpc(
            "uploads.abort",
            json!({"uploadId":pending[1]}),
            Some(&stranger),
        )
        .await
        .error(403, "access.denied");
    for upload in &pending[1..] {
        server
            .rpc("uploads.abort", json!({"uploadId":upload}), Some(&owner))
            .await
            .value();
    }
    assert_eq!(
        server
            .rpc("uploads.incoming", json!({}), Some(&owner))
            .await
            .value()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // A contributor may hold at most half of the space still available to them.
    execute(
        &server,
        "UPDATE hyori_users SET quota_bytes=used_bytes+reserved_bytes+1000 WHERE id=$1",
        &owner_id,
    )
    .await;
    begin(&server, &visitor, Some(&folder), 600)
        .await
        .error(409, "storage.quotaExceeded");
    begin(&server, &visitor, Some(&folder), 400).await.value();
    // The owner's own uploads are not limited by the contribution share.
    begin(&server, &owner, None, 400).await.value();

    // A part whose previous request still holds the lease is told to retry, not that it conflicts.
    let busy = id(&begin(&server, &owner, None, 3).await);
    execute(
        &server,
        "UPDATE hyori_uploads SET lease_token='dead-request',lease_until=now()+interval '1 minute' WHERE id=$1",
        &busy,
    )
    .await;
    let retry = put(&server, &owner, &busy, b"abc").await;
    assert_eq!(retry.status(), 409);
    assert_eq!(
        retry.json::<Value>().await.unwrap()["error"]["code"],
        "uploads.busy"
    );
    execute(
        &server,
        "UPDATE hyori_uploads SET lease_token=NULL,lease_until=NULL WHERE id=$1",
        &busy,
    )
    .await;
    assert_eq!(put(&server, &owner, &busy, b"abc").await.status(), 200);
    pg.stop();
}

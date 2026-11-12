#[path = "support/link_capability.rs"]
mod link_capability;
mod support;

use hyori_server::{
    auth::{digest, random_token},
    db::sql,
};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, Reply, TestServer};

async fn count(server: &TestServer, query: &str) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(query, vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap()
}
/// A public link to a new folder: its share id, its token and the folder id.
async fn link(
    server: &TestServer,
    admin: &str,
    name: &str,
    extra: Value,
) -> (String, String, String) {
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":name}),
            Some(admin),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut input = json!({"itemId":folder,"public":true,"role":"viewer"});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let link = server.rpc("shares.create", input, Some(admin)).await;
    let share = link.value()["id"].as_str().unwrap().to_owned();
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    (share, token, folder)
}
async fn list(server: &TestServer, folder: &str, cookie: &str) -> Reply {
    server
        .rpc("files.list", json!({"parentId":folder}), Some(cookie))
        .await
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: opening a public link stores nothing"]
async fn anonymous_grant_storage_is_bounded_without_locking_out_several_browsers() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let (share, token, folder) = link(&server, &admin, "Shared", json!({})).await;
    let mut browsers = Vec::new();
    for _ in 0..4 {
        let visitor = server
            .rpc("shares.resolve", json!({"token":token}), None)
            .await;
        visitor.value();
        assert!(visitor.cookie.is_some());
        browsers.push(visitor.credential());
    }
    for _ in 0..50 {
        server
            .rpc("shares.resolve", json!({"token":token}), None)
            .await
            .value();
    }
    // Cookie-bearing visitors must retain access even after a no-cookie flood.
    for browser in &browsers {
        list(&server, &folder, browser).await.value();
    }
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS live FROM hyori_grants WHERE share_id=$1",
            vec![share.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let live = row.try_get::<i64>("", "live").unwrap();
    eprintln!(
        "4 browsers + 50 no-cookie resolves: stored grants={live}; original browsers still read"
    );
    assert_eq!(live, 0, "opening a public link must store nothing");
    server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .value();
    pg.stop();
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: link capabilities authorize only what they were issued for"]
async fn link_capabilities_are_refused_when_forged_expired_moved_revoked_or_outdated() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let (a, a_token, a_folder) = link(&server, &admin, "A", json!({})).await;
    let (b, _, b_folder) = link(&server, &admin, "B", json!({})).await;
    let (locked, locked_token, locked_folder) = link(
        &server,
        &admin,
        "Locked",
        json!({"password":"first link password"}),
    )
    .await;
    let opened = server
        .rpc("shares.resolve", json!({"token":a_token}), None)
        .await
        .credential();
    let (name, value) = opened.split_once('=').unwrap();
    assert_eq!(name, format!("hyori_grant_{a}"));
    let (issued, expires) = link_capability::times(value);
    assert_eq!(expires - issued, 12 * 60 * 60);
    list(&server, &a_folder, &opened).await.value();
    // A password-protected link issues nothing until it is unlocked.
    let refused = server
        .rpc("shares.resolve", json!({"token":locked_token}), None)
        .await;
    assert_eq!(refused.value()["requiresPassword"], true);
    assert!(refused.cookies.is_empty());

    let mut wrong_mac = value.to_owned();
    let last = wrong_mac.pop().unwrap();
    wrong_mac.push(if last == '0' { '1' } else { '0' });
    let expired = link_capability::expired(&server, &a).await;
    // Another share's id in the capability, and the capability under another share's name.
    let moved = value.replacen(&a, &b, 1);
    let renamed = format!("hyori_grant_{b}={value}");
    let cases = [
        // No live credential at all: the visitor is anonymous.
        (
            "wrong MAC",
            format!("{name}={wrong_mac}"),
            &a_folder,
            401,
            "auth.required",
        ),
        (
            "expired",
            format!("{name}={expired}"),
            &a_folder,
            401,
            "auth.required",
        ),
        (
            "share id changed",
            format!("hyori_grant_{b}={moved}"),
            &b_folder,
            401,
            "auth.required",
        ),
        // Still a credential for A, which grants nothing in B.
        (
            "renamed to another share",
            renamed.clone(),
            &b_folder,
            403,
            "access.denied",
        ),
    ];
    for (case, cookie, folder, status, code) in cases {
        let reply = list(&server, folder, &cookie).await;
        eprintln!("{case}: {} {}", reply.status, reply.body["error"]["code"]);
        reply.error(status, code);
    }
    // Renaming the cookie still leaves the capability's own share readable, nothing more.
    list(&server, &a_folder, &renamed).await.value();

    // Issued before the link's password changed: refused, and the visitor must unlock again.
    let unlocked = server
        .rpc(
            "shares.unlock",
            json!({"token":locked_token,"password":"first link password"}),
            None,
        )
        .await
        .credential();
    list(&server, &locked_folder, &unlocked).await.value();
    let other_hash = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT password_hash FROM hyori_shares WHERE id=$1",
            vec![locked.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<String>("", "password_hash")
        .unwrap();
    // What setting a new link password does to the stored hash: it changes.
    let other_hash = format!("{other_hash}0");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET password_hash=$2 WHERE id=$1",
            vec![locked.clone().into(), other_hash.into()],
        ))
        .await
        .unwrap();
    let after_change = list(&server, &locked_folder, &unlocked).await;
    eprintln!(
        "issued before a password change: {} {}",
        after_change.status, after_change.body["error"]["code"]
    );
    after_change.error(401, "auth.required");
    let again = server
        .rpc(
            "shares.resolve",
            json!({"token":locked_token}),
            Some(&unlocked),
        )
        .await;
    assert_eq!(again.value()["requiresPassword"], true);

    // Issued before the link was revoked: refused from then on.
    server
        .rpc("shares.revoke", json!({"id":a}), Some(&admin))
        .await
        .value();
    let after_revoke = list(&server, &a_folder, &opened).await;
    eprintln!(
        "issued before a revocation: {} {}",
        after_revoke.status, after_revoke.body["error"]["code"]
    );
    after_revoke.error(401, "auth.required");
    assert_eq!(
        count(&server, "SELECT count(*) AS n FROM hyori_grants").await,
        0
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: grants stored before capabilities keep working until they expire"]
async fn grants_stored_before_capabilities_stay_valid_until_they_expire() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let (share, token, folder) = link(&server, &admin, "Legacy", json!({})).await;
    let grant = random_token();
    server.state.db.execute_raw(sql("INSERT INTO hyori_grants(token_digest,share_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", vec![digest(&grant).into(), share.clone().into()])).await.unwrap();
    let cookie = format!("hyori_grant_{share}={grant}");
    list(&server, &folder, &cookie).await.value();
    // Reopening the link keeps the stored grant rather than issuing another credential.
    let reopened = server
        .rpc("shares.resolve", json!({"token":token}), Some(&cookie))
        .await
        .credential();
    assert_eq!(reopened, cookie);
    assert_eq!(
        count(&server, "SELECT count(*) AS n FROM hyori_grants").await,
        1
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_grants SET expires_at=now()-interval '1 second' WHERE token_digest=$1",
            vec![digest(&grant).into()],
        ))
        .await
        .unwrap();
    assert_ne!(list(&server, &folder, &cookie).await.status, 200);
    pg.stop();
}

mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: anonymous public links have bounded persistent grants"]
async fn anonymous_grant_storage_is_bounded_without_locking_out_several_browsers() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Shared"}),
            Some(&admin),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"public":true,"role":"viewer"}),
            Some(&admin),
        )
        .await;
    let share = link.value()["id"].as_str().unwrap();
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
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
        let reply = server
            .rpc("shares.resolve", json!({"token":token}), None)
            .await;
        if reply.status == 429 {
            reply.error(429, "auth.rateLimited");
        } else {
            reply.value();
        }
    }
    // Cookie-bearing visitors must retain access even after a no-cookie flood.
    for browser in browsers {
        server
            .rpc("files.list", json!({"parentId":folder}), Some(&browser))
            .await
            .value();
    }
    let row = server.state.db.query_one_raw(sql("SELECT count(*) AS live, max(extract(epoch FROM expires_at-created_at))::bigint AS max_lifetime FROM hyori_grants WHERE share_id=$1 AND expires_at>now()", vec![share.into()])).await.unwrap().unwrap();
    let live = row.try_get::<i64>("", "live").unwrap();
    let lifetime = row.try_get::<Option<i64>>("", "max_lifetime").unwrap();
    eprintln!(
        "4 browsers + 50 no-cookie resolves: live_grants={live} max_lifetime_seconds={lifetime:?}; original browsers still read"
    );
    // Proposed bound, subject to review: at most 32 persistent grants per share, not per caller.
    assert!(
        live <= 32,
        "anonymous caller grew live grant storage to {live}, exceeding proposed cap 32"
    );
    let newcomer = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    newcomer.value();
    pg.stop();
}

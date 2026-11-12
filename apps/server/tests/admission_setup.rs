mod support;

use hyori_server::auth::random_token;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: wrong bootstrap tokens cannot deny setup"]
async fn wrong_setup_tokens_do_not_delay_the_correct_token() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let password = random_token();
    for _ in 0..10 {
        server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":password,"setupToken":random_token()}), None)
            .await.error(403, "auth.setupDenied");
    }
    let reply = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":password,"setupToken":pg.config.setup_token}), None).await;
    eprintln!(
        "after 10 wrong tokens: correct setup status={} body={}",
        reply.status, reply.body
    );
    reply.value();
    assert!(reply.cookie.is_some());
    assert!(reply.credential().contains("hyori_session="));
    pg.stop();
}

mod support;

use hyori_server::{AppState, auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: wrong bootstrap tokens cannot deny setup"]
async fn wrong_setup_tokens_do_not_delay_the_correct_token() {
    let pg = Postgres::start().await;
    let mut config = pg.config.clone();
    // Behind a listed proxy, so the guesses could also spend per-client and all-client budgets.
    config.trusted_proxies = vec!["127.0.0.1".parse().unwrap()];
    let server = TestServer::start(config).await;
    let password = random_token();
    let setup = |token: &str| json!({"email":"admin@example.test","name":"Admin","password":password,"setupToken":token});
    // More than the 100 guesses all clients together used to be allowed, from ten addresses.
    for guess in 0..120 {
        let client = format!("203.0.113.{}", guess % 10);
        server
            .rpc_from(Some(&client), "auth.setup", setup(&random_token()), None)
            .await
            .error(403, "auth.setupDenied");
    }
    for _ in 0..10 {
        server
            .rpc("auth.setup", setup(&random_token()), None)
            .await
            .error(403, "auth.setupDenied");
    }
    let counters = server
        .state
        .db
        .query_one_raw(sql("SELECT count(*) AS n FROM hyori_rate_limits", vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "n")
        .unwrap();
    let reply = server
        .rpc_from(
            Some("203.0.113.0"),
            "auth.setup",
            setup(&pg.config.setup_token),
            None,
        )
        .await;
    eprintln!(
        "after 130 wrong tokens: attempt counters={counters}; correct setup status={} body={}",
        reply.status, reply.body
    );
    assert_eq!(counters, 0, "wrong setup tokens must not be counted");
    reply.value();
    assert!(reply.cookie.is_some());
    assert!(reply.credential().contains("hyori_session="));
    pg.stop();
}

#[tokio::test]
#[ignore = "unique loopback PostgreSQL: a weak setup token refuses to start only before setup"]
async fn a_weak_setup_token_is_refused_until_an_administrator_exists() {
    let pg = Postgres::start().await;
    let weak = |token: &str| {
        let mut config = pg.config.clone();
        config.setup_token = token.to_owned();
        config
    };
    let short = "a-legacy-24-character-tk";
    assert_eq!(short.chars().count(), 24);
    for token in [short.to_owned(), "ab".repeat(20)] {
        assert!(
            AppState::connect(weak(&token)).await.is_err(),
            "{token} must not start an uninitialized instance"
        );
    }
    let server = TestServer::start(pg.config.clone()).await;
    server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.value();
    server.state.db.clone().close().await.unwrap();
    drop(server);
    // Initialized: the token is never used again, so an existing deployment keeps starting.
    for token in [short.to_owned(), "ab".repeat(20)] {
        let state = AppState::connect(weak(&token)).await;
        assert!(
            state.is_ok(),
            "{token} must not stop an initialized instance"
        );
        state.unwrap().db.clone().close().await.unwrap();
    }
    pg.stop();
}

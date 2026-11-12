mod support;

use hyori_server::auth::random_token;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use support::{Postgres, TestServer};
use tokio::task::JoinSet;

#[tokio::test]
#[ignore = "real concurrent HTTP and unique loopback PostgreSQL: unknown emails cannot deny correct login"]
async fn correct_credentials_sign_in_during_unknown_email_flood_without_client_addresses() {
    let pg = Postgres::start().await;
    let server = Arc::new(TestServer::start(pg.config.clone()).await);
    let password = random_token();
    server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":password,"setupToken":pg.config.setup_token}), None).await.value();
    // Verify the control without carrying the issued device cookie into the attack case.
    let control = server
        .rpc(
            "auth.login",
            json!({"email":"admin@example.test","password":password}),
            None,
        )
        .await;
    control.value();
    assert!(control.cookie.is_some());
    assert!(control.credential().contains("hyori_session="));
    let mut flood = JoinSet::new();
    for index in 0..64 {
        let server = server.clone();
        flood.spawn(async move {
            server.rpc("auth.login", json!({"email":format!("unknown-{index}@example.test"),"password":"wrong-password"}), None).await
        });
    }
    // A completed rejection is external evidence that the flood reached admission, not a sleep
    // that assumes how fast this host hashes passwords. No private semaphore is manipulated.
    let mut statuses = Vec::new();
    while let Some(reply) = flood.join_next().await {
        let reply = reply.unwrap();
        statuses.push(reply.status);
        if reply.status == 429 {
            break;
        }
    }
    let start = Instant::now();
    let victim = server
        .rpc(
            "auth.login",
            json!({"email":"admin@example.test","password":password}),
            None,
        )
        .await;
    let elapsed = start.elapsed();
    while let Some(reply) = flood.join_next().await {
        statuses.push(reply.unwrap().status);
    }
    eprintln!(
        "64 unknown-email requests: 401={} 429={}; correct login status={} elapsed_ms={} body={}",
        statuses.iter().filter(|&&s| s == 401).count(),
        statuses.iter().filter(|&&s| s == 429).count(),
        victim.status,
        elapsed.as_millis(),
        victim.body
    );
    victim.value();
    assert!(
        elapsed < Duration::from_secs(10),
        "correct login must not wait behind the entire anonymous queue"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: failed-login admission must not enumerate accounts"]
async fn known_and_unknown_accounts_have_matching_failure_responses_and_timing() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":pg.config.setup_token}), None).await.value();
    let mut known_times = Vec::new();
    let mut unknown_times = Vec::new();
    for attempt in 0..12 {
        let mut replies = Vec::new();
        // Alternate order to avoid consistently giving one category the warmer server.
        let emails = if attempt % 2 == 0 {
            ["admin@example.test", "missing@example.test"]
        } else {
            ["missing@example.test", "admin@example.test"]
        };
        for email in emails {
            let start = Instant::now();
            let reply = server
                .rpc(
                    "auth.login",
                    json!({"email":email,"password":"wrong-password"}),
                    None,
                )
                .await;
            let times = if email == "admin@example.test" {
                &mut known_times
            } else {
                &mut unknown_times
            };
            times.push(start.elapsed().as_millis());
            replies.push(reply);
        }
        assert_eq!(
            replies[0].status, replies[1].status,
            "attempt {attempt}: account existence changed rejection status"
        );
        assert_eq!(
            replies[0].body, replies[1].body,
            "attempt {attempt}: account existence changed rejection body"
        );
        match replies[0].status {
            401 => replies[0].error(401, "auth.invalidCredentials"),
            429 => replies[0].error(429, "auth.rateLimited"),
            status => panic!("unexpected failed-login status {status}"),
        }
    }
    // The first ten requests reach password checking; later requests exercise the limit.
    known_times[..10].sort_unstable();
    unknown_times[..10].sort_unstable();
    let known = known_times[5];
    let unknown = unknown_times[5];
    eprintln!(
        "failed-login medians before per-email limit: known_ms={known} unknown_ms={unknown}; all 12 paired status/body responses match"
    );
    // A coarse smoke alarm for a fast unknown-email shortcut, not a statistical proof of secrecy.
    assert!(
        known.max(unknown) <= known.min(unknown) * 2 + 50,
        "account existence produced materially different failure latency"
    );
    pg.stop();
}

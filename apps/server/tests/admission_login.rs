mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use support::{Postgres, TestServer};
use tokio::task::JoinSet;

/// More failing sign-ins than there are RPC slots (128), so the test also fails if their wait
/// held a slot.
const FLOOD: usize = 160;

#[tokio::test]
#[ignore = "real concurrent HTTP and unique loopback PostgreSQL: unknown emails cannot deny correct login"]
async fn correct_credentials_sign_in_during_unknown_email_flood_without_client_addresses() {
    let pg = Postgres::start().await;
    // The deployed deadline, long enough for every batch below to be waiting at once.
    let mut config = pg.config.clone();
    config.sign_in_answer = hyori_server::config::SIGN_IN_ANSWER;
    let server = Arc::new(TestServer::start(config).await);
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
    let counters = || async {
        server
            .state
            .db
            .query_one_raw(sql("SELECT count(*) AS n FROM hyori_rate_limits", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i64>("", "n")
            .unwrap()
    };
    // In batches, so no more requests are in handlers at once than there are RPC slots: each
    // batch has spent its attempt counters, which sign-in does first, before the next is sent.
    // The counters are external evidence that the requests reached the server; no timing guess.
    let mut flood = JoinSet::new();
    let wait = Instant::now();
    for batch in (0..FLOOD).collect::<Vec<_>>().chunks(32) {
        let before = counters().await;
        for &index in batch {
            let server = server.clone();
            flood.spawn(async move {
                let reply = server.rpc("auth.login", json!({"email":format!("unknown-{index}@example.test"),"password":"wrong-password"}), None).await;
                (reply, Instant::now())
            });
        }
        while counters().await < before + batch.len() as i64 {
            assert!(
                wait.elapsed() < Duration::from_secs(30),
                "flood never arrived"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
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
    let bystander = server.rpc("auth.status", json!({}), None).await;
    let answered = Instant::now();
    let mut replies = Vec::new();
    while let Some(reply) = flood.join_next().await {
        replies.push(reply.unwrap());
    }
    let statuses: Vec<_> = replies.iter().map(|(reply, _)| reply.status).collect();
    let first_failure = replies.iter().map(|(_, at)| *at).min().unwrap();
    eprintln!(
        "{FLOOD} unknown-email requests: 401={} 429={} 503={}; correct login status={} elapsed_ms={} body={}; status call={}; answered {} ms before the first flood reply",
        statuses.iter().filter(|&&s| s == 401).count(),
        statuses.iter().filter(|&&s| s == 429).count(),
        statuses.iter().filter(|&&s| s == 503).count(),
        victim.status,
        elapsed.as_millis(),
        victim.body,
        bystander.status,
        first_failure
            .saturating_duration_since(answered)
            .as_millis(),
    );
    victim.value();
    bystander.value();
    assert!(
        answered < first_failure,
        "the correct sign-in must be answered while the flood is still waiting"
    );
    for (reply, _) in &replies {
        reply.error(401, "auth.invalidCredentials");
        assert_eq!(reply.body, replies[0].0.body);
    }
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

#[tokio::test]
#[ignore = "real concurrent HTTP and PostgreSQL: a correct password is never answered as a wrong one"]
async fn simultaneous_correct_sign_ins_succeed_or_are_told_to_retry() {
    use better_auth::{PasswordHasher, ScryptPasswordHasher};
    let pg = Postgres::start().await;
    let mut config = pg.config.clone();
    config.sign_in_answer = hyori_server::config::SIGN_IN_ANSWER;
    let server = Arc::new(TestServer::start(config).await);
    let password = random_token();
    let hash = ScryptPasswordHasher.hash(&password).await.unwrap();
    // Separate accounts, so no per-email attempt limit is involved.
    let accounts = 16;
    for index in 0..accounts {
        let id = random_token();
        server.state.db.execute_raw(sql("INSERT INTO hyori_users(id,email,name,role,quota_bytes) VALUES ($1,$2,'Member','user',0)", vec![id.clone().into(), format!("member-{index}@example.test").into()])).await.unwrap();
        server
            .state
            .db
            .execute_raw(sql(
                "INSERT INTO hyori_credentials(id,user_id,password_hash) VALUES ($1,$2,$3)",
                vec![random_token().into(), id.into(), hash.clone().into()],
            ))
            .await
            .unwrap();
    }
    let mut sign_ins = JoinSet::new();
    for index in 0..accounts {
        let server = server.clone();
        let password = password.clone();
        sign_ins.spawn(async move {
            server
                .rpc(
                    "auth.login",
                    json!({"email":format!("member-{index}@example.test"),"password":password}),
                    None,
                )
                .await
        });
    }
    let replies = sign_ins.join_all().await;
    let count = |status| {
        replies
            .iter()
            .filter(|reply| reply.status == status)
            .count()
    };
    eprintln!(
        "{accounts} simultaneous correct sign-ins: 200={} 429={} other={}",
        count(200),
        count(429),
        accounts - count(200) - count(429)
    );
    for reply in &replies {
        if reply.status == 429 {
            assert_eq!(
                reply.body["error"]["message"],
                "Sign-in is busy. Try again in a moment"
            );
        } else {
            reply.value();
        }
    }
    use hyori_server::auth::{SIGN_IN_RUNNING, SIGN_IN_WAITING};
    assert!(count(200) >= SIGN_IN_RUNNING + SIGN_IN_WAITING);
    pg.stop();
}

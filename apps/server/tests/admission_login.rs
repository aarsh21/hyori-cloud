mod support;

use hyori_server::{
    auth::{SIGN_IN_RUNNING, SIGN_IN_WAITING, random_token},
    db::sql,
};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use support::{Postgres, Reply, TestServer};
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

/// Accounts `member-<n>@example.test` sharing one password, inserted directly so creating them
/// spends no sign-in or hashing capacity.
async fn members(server: &TestServer, count: usize, password: &str) {
    use better_auth::{PasswordHasher, ScryptPasswordHasher};
    let hash = ScryptPasswordHasher.hash(password).await.unwrap();
    for index in 0..count {
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
}
fn sign_in(
    server: &Arc<TestServer>,
    index: usize,
    password: &str,
) -> tokio::task::JoinHandle<Reply> {
    let server = server.clone();
    let body = json!({"email":format!("member-{index}@example.test"),"password":password});
    tokio::spawn(async move { server.rpc("auth.login", body, None).await })
}

#[tokio::test]
#[ignore = "real concurrent HTTP and PostgreSQL: every place in the sign-in lane ends signed in, and busy answers are not attempts"]
async fn a_full_sign_in_lane_signs_everyone_in_and_answers_busy_without_counting() {
    let pg = Postgres::start().await;
    let mut config = pg.config.clone();
    config.sign_in_answer = hyori_server::config::SIGN_IN_ANSWER;
    let server = Arc::new(TestServer::start(config).await);
    let password = random_token();
    let places = SIGN_IN_RUNNING + SIGN_IN_WAITING;
    let extra = 4;
    members(&server, places + extra, &password).await;
    let telemetry = || async {
        server
            .client
            .get(format!("{}/metrics", server.url))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap()
    };
    let refused = |text: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix("hyori_busy_refusals_total{lane=\"sign_in\"} "))
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    let before = telemetry().await;
    // Blocking writes to the attempt counters (reads still pass) stops each admitted sign-in
    // where it spends its counter, inside the lane, so the lane fills deterministically rather
    // than by timing.
    let counters = server.state.db.begin().await.unwrap();
    counters
        .execute_unprepared("LOCK TABLE hyori_rate_limits IN SHARE MODE")
        .await
        .unwrap();
    let admitted: Vec<_> = (0..places)
        .map(|index| sign_in(&server, index, &password))
        .collect();
    let start = Instant::now();
    loop {
        let row = server.state.db.query_one_raw(sql("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'", vec![])).await.unwrap().unwrap();
        if row.try_get::<i64>("", "n").unwrap() >= places as i64 {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "the lane never filled"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The lane is full: these are told it is busy straight away, and spend nothing.
    let mut busy = Vec::new();
    for index in places..places + extra {
        let reply =
            tokio::time::timeout(Duration::from_secs(2), sign_in(&server, index, &password))
                .await
                .expect("a busy lane must answer at once")
                .unwrap();
        busy.push(reply);
    }
    counters.rollback().await.unwrap();
    let mut statuses = Vec::new();
    for reply in admitted {
        let reply = reply.await.unwrap();
        statuses.push(reply.status);
        reply.value();
    }
    let elapsed = start.elapsed();
    let counted = |index: usize| {
        let key = hyori_server::auth::digest(&format!("login:member-{index}@example.test"));
        let server = server.clone();
        async move {
            server
                .state
                .db
                .query_one_raw(sql(
                    "SELECT count(*) AS n FROM hyori_rate_limits WHERE key_digest=$1",
                    vec![key.into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "n")
                .unwrap()
        }
    };
    let mut busy_counted = 0;
    for index in places..places + extra {
        busy_counted += counted(index).await;
    }
    eprintln!(
        "{places} places: {} signed in within {} ms; {extra} more answered {:?} with {busy_counted} attempts counted",
        statuses.iter().filter(|&&status| status == 200).count(),
        elapsed.as_millis(),
        busy.iter().map(|reply| reply.status).collect::<Vec<_>>(),
    );
    for reply in &busy {
        reply.error(429, "auth.signInBusy");
    }
    assert_eq!(busy_counted, 0, "busy answers must not count as attempts");
    for index in 0..places {
        assert_eq!(counted(index).await, 1);
    }
    let after = telemetry().await;
    assert_eq!(refused(&after) - refused(&before), extra as u64);
    assert!(after.lines().any(|line| {
        line.starts_with("hyori_admission_wait_seconds_sum{lane=\"sign_in\",outcome=\"admitted\"} ")
            && line
                .split_whitespace()
                .last()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                > 0.0
    }));
    pg.stop();
}

/// Floods sign-ins with wrong passwords for `flooded` known emails whose attempt budgets are
/// already spent, while other members sign in one at a time with the right password. Every one of
/// them must be signed in on the first answer: a spent budget never holds a place in the lane.
async fn spent_budget_flood(flooded: usize) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let pg = Postgres::start().await;
    let mut config = pg.config.clone();
    config.sign_in_answer = hyori_server::config::SIGN_IN_ANSWER;
    let server = Arc::new(TestServer::start(config).await);
    let password = random_token();
    let people = 16;
    members(&server, flooded + people, &password).await;
    let wrong = |index: usize| json!({"email":format!("member-{index}@example.test"),"password":"wrong password"});
    for index in 0..flooded {
        for _ in 0..10 {
            server
                .rpc("auth.login", wrong(index), None)
                .await
                .error(401, "auth.invalidCredentials");
        }
        server
            .rpc("auth.login", wrong(index), None)
            .await
            .error(429, "auth.rateLimited");
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (limited, other) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let mut flood = JoinSet::new();
    for worker in 0..96 {
        let (server, stop, limited, other) =
            (server.clone(), stop.clone(), limited.clone(), other.clone());
        flood.spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                let reply = server
                    .rpc("auth.login", wrong(worker % flooded), None)
                    .await;
                let counter =
                    if reply.status == 429 && reply.body["error"]["code"] == "auth.rateLimited" {
                        &limited
                    } else {
                        &other
                    };
                counter.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut first_answers = Vec::new();
    let mut slowest = Duration::ZERO;
    for index in flooded..flooded + people {
        let start = Instant::now();
        let reply = sign_in(&server, index, &password).await.unwrap();
        slowest = slowest.max(start.elapsed());
        first_answers.push(
            reply.body["error"]["code"]
                .as_str()
                .unwrap_or("signed in")
                .to_owned(),
        );
    }
    stop.store(true, Ordering::Relaxed);
    flood.join_all().await;
    let signed_in = first_answers
        .iter()
        .filter(|code| *code == "signed in")
        .count();
    eprintln!(
        "{flooded} spent email(s) flooded by 96 callers: {} answered auth.rateLimited, {} otherwise; {people} correct sign-ins by others: {signed_in} signed in on the first answer, first answers {first_answers:?}, slowest {} ms",
        limited.load(Ordering::Relaxed),
        other.load(Ordering::Relaxed),
        slowest.as_millis()
    );
    assert_eq!(
        signed_in, people,
        "a spent budget made someone else's sign-in busy"
    );
    assert_eq!(
        other.load(Ordering::Relaxed),
        0,
        "a spent budget must be refused before the lane"
    );
    pg.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real concurrent HTTP and PostgreSQL: sign-ins with a spent budget never take a place in the lane"]
async fn a_flood_on_one_spent_email_never_makes_other_sign_ins_busy() {
    spent_budget_flood(1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "real concurrent HTTP and PostgreSQL: sign-ins with a spent budget never take a place in the lane"]
async fn a_flood_on_several_spent_emails_never_makes_other_sign_ins_busy() {
    spent_budget_flood(4).await;
}

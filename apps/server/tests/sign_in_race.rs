mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;
use std::{future::Future, sync::Arc, time::Duration};
use support::{Postgres, Reply, TestServer};

/// Backends of this database waiting for a lock, row or advisory.
async fn lock_waiters(server: &TestServer) -> i64 {
    server.state.db.query_one_raw(sql("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'", vec![])).await.unwrap().unwrap().try_get("", "n").unwrap()
}
async fn until_lock_waiters(server: &TestServer, count: i64) {
    let start = std::time::Instant::now();
    while lock_waiters(server).await < count {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "expected {count} lock waiters"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Signs in to `email` with its current `password` while `replace` replaces that password, in
/// this order: the sign-in has read and verified the old hash, then `replace` commits, then the
/// sign-in goes on to create its session. Returns the sign-in's reply and how many of the
/// account's sessions remain other than `keep` (a token the replacement leaves signed in).
///
/// The order is fixed by locks, not timing. The test holds the account's credential row, so
/// `replace` waits for it. The sign-in then verifies the old hash, which no one has changed yet,
/// and stops either where it locks the credential row (after the replacement, which queued
/// first) or, if it takes no such lock, at a trigger that holds every session insert until the
/// replacement has committed.
async fn race<F>(
    server: &Arc<TestServer>,
    email: &str,
    password: &str,
    user_id: &str,
    keep: Option<&str>,
    replace: F,
) -> (Reply, i64)
where
    F: Future<Output = ()> + Send + 'static,
{
    let db = &server.state.db;
    db.execute_unprepared("CREATE FUNCTION test_hold_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(4242); RETURN NEW; END $$; CREATE TRIGGER test_hold_session BEFORE INSERT ON hyori_sessions FOR EACH ROW EXECUTE FUNCTION test_hold_session()").await.unwrap();
    let inserts = db.begin().await.unwrap();
    inserts
        .execute_unprepared("SELECT pg_advisory_xact_lock(4242)")
        .await
        .unwrap();
    let credential = db.begin().await.unwrap();
    credential
        .execute_raw(sql(
            "SELECT 1 FROM hyori_credentials WHERE user_id=$1 FOR UPDATE",
            vec![user_id.into()],
        ))
        .await
        .unwrap();
    let replacing = tokio::spawn(replace);
    until_lock_waiters(server, 1).await;
    let signing_in = {
        let server = server.clone();
        let body = json!({"email":email,"password":password});
        tokio::spawn(async move { server.rpc("auth.login", body, None).await })
    };
    until_lock_waiters(server, 2).await;
    credential.rollback().await.unwrap();
    replacing.await.unwrap();
    inserts.commit().await.unwrap();
    let reply = signing_in.await.unwrap();
    db.execute_unprepared(
        "DROP TRIGGER test_hold_session ON hyori_sessions; DROP FUNCTION test_hold_session()",
    )
    .await
    .unwrap();
    let keep = keep.map(hyori_server::auth::digest);
    let sessions = db
        .query_one_raw(sql(
            "SELECT count(*) AS n FROM hyori_sessions WHERE user_id=$1 AND token_digest IS DISTINCT FROM $2",
            vec![user_id.into(), keep.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "n")
        .unwrap();
    (reply, sessions)
}

#[tokio::test]
#[ignore = "real HTTP and PostgreSQL: a password replaced during sign-in leaves no session"]
async fn a_password_replaced_while_signing_in_creates_no_session() {
    let pg = Postgres::start().await;
    let server = Arc::new(TestServer::start(pg.config.clone()).await);
    let password = random_token();
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":password,"setupToken":pg.config.setup_token}), None).await;
    let user_id = admin.value()["id"].as_str().unwrap().to_owned();
    assert!(admin.cookie.is_some());
    let earlier = admin.credential();
    // What a password reset does, in its lock order: the user, the credential, then sessions.
    let replace = {
        let server = server.clone();
        let user_id = user_id.clone();
        async move {
            let tx = server.state.db.begin().await.unwrap();
            for statement in [
                "SELECT id FROM hyori_users WHERE id=$1 AND status='active' FOR KEY SHARE",
                "SELECT 1 FROM hyori_credentials WHERE user_id=$1 FOR UPDATE",
                "UPDATE hyori_credentials SET password_hash='00000000000000000000000000000000:00',updated_at=now() WHERE user_id=$1",
                "DELETE FROM hyori_sessions WHERE user_id=$1",
            ] {
                tx.execute_raw(sql(statement, vec![user_id.clone().into()]))
                    .await
                    .unwrap();
            }
            tx.commit().await.unwrap();
        }
    };
    let (reply, sessions) = race(
        &server,
        "admin@example.test",
        &password,
        &user_id,
        None,
        replace,
    )
    .await;
    eprintln!(
        "sign-in racing a replacement: status={} body={}; sessions afterwards={sessions}",
        reply.status, reply.body
    );
    assert_eq!(sessions, 0, "the old password produced a live session");
    reply.error(401, "auth.invalidCredentials");
    let status = server.rpc("auth.status", json!({}), Some(&earlier)).await;
    assert!(status.value()["user"].is_null());
    pg.stop();
}

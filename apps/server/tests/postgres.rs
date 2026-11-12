mod support;
use hyori_server::{auth::digest, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, TestServer};
fn account(email: &str) -> Value {
    json!({"email": email, "name":"  Cafe\u{301} Person  ", "password":"correct horse battery staple"})
}

#[tokio::test]
#[ignore = "starts a unique loopback Docker PostgreSQL container; run with --ignored"]
async fn auth_postgres_http_lifecycle() {
    let postgres = Postgres::start().await;
    let server = TestServer::start(postgres.config.clone()).await;
    server.rpc("auth.status", json!({}), None).await.value();
    assert_eq!(
        server.rpc("auth.status", json!({}), None).await.value()["initialized"],
        false
    );
    let mut unauthorized_setup = account("intruder@example.test");
    unauthorized_setup["setupToken"] = json!("not-the-operator-token");
    server
        .rpc("auth.setup", unauthorized_setup, None)
        .await
        .error(403, "auth.setupDenied");
    let mut setup = account("  Admin@Example.test ");
    setup["setupToken"] = json!(postgres.config.setup_token);
    let (one, two) = tokio::join!(
        server.rpc("auth.setup", setup.clone(), None),
        server.rpc("auth.setup", setup, None)
    );
    let (success, denied) = if one.status == 200 {
        (one, two)
    } else {
        (two, one)
    };
    denied.error(403, "auth.setupDenied");
    assert_eq!(success.value()["role"], "admin");
    assert_eq!(success.value()["email"], "admin@example.test");
    assert_eq!(success.value()["name"], "Café Person");
    let admin = success.credential();
    let cookie = success.cookie.unwrap();
    for attribute in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=604800"] {
        assert!(cookie.contains(attribute));
    }
    let row = server
        .state
        .db
        .query_one_raw(sql("SELECT count(*) AS count FROM hyori_users", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 1);
    let row = server.state.db.query_one_raw(sql("SELECT token_digest, extract(epoch from (expires_at-created_at))::bigint AS lifetime FROM hyori_sessions", vec![])).await.unwrap().unwrap();
    let token = admin.split_once('=').unwrap().1;
    assert_eq!(
        row.try_get::<String>("", "token_digest").unwrap(),
        digest(token)
    );
    assert_eq!(row.try_get::<i64>("", "lifetime").unwrap(), 604800);
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&admin))
            .await
            .value()["user"]["email"],
        "admin@example.test"
    );
    server
        .rpc(
            "auth.login",
            json!({"email":"admin@example.test", "password":"wrong"}),
            None,
        )
        .await
        .error(401, "auth.invalidCredentials");
    server
        .rpc(
            "auth.login",
            json!({"email":"unknown@example.test", "password":"wrong"}),
            None,
        )
        .await
        .error(401, "auth.invalidCredentials");
    let signed_in = server
        .rpc(
            "auth.login",
            json!({"email":" ADMIN@EXAMPLE.TEST ","password":"correct horse battery staple"}),
            None,
        )
        .await;
    signed_in.value();
    let second_admin = signed_in.credential();
    server
        .rpc("auth.logout", json!({}), Some(&second_admin))
        .await
        .value();
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&second_admin))
            .await
            .value()["user"],
        Value::Null
    );
    assert_ne!(
        server
            .rpc("auth.status", json!({}), Some(&admin))
            .await
            .value()["user"],
        Value::Null
    );
    server
        .rpc("admin.createUser", account("guest@example.test"), None)
        .await
        .error(401, "auth.required");
    let guest = server
        .rpc(
            "admin.createUser",
            account("guest@example.test"),
            Some(&admin),
        )
        .await;
    let guest_id = guest.value()["id"].as_str().unwrap().to_owned();
    assert_eq!(guest.value()["role"], "user");
    assert!(guest.cookie.is_none());
    server
        .rpc(
            "admin.createUser",
            account("guest@example.test"),
            Some(&admin),
        )
        .await
        .error(409, "resource.conflict");
    let guest_login = server
        .rpc(
            "auth.login",
            json!({"email":"guest@example.test","password":"correct horse battery staple"}),
            None,
        )
        .await;
    guest_login.value();
    let guest_cookie = guest_login.credential();
    server
        .rpc("admin.createInvite", json!({}), Some(&guest_cookie))
        .await
        .error(403, "access.denied");
    let invite = server
        .rpc(
            "admin.createInvite",
            json!({"email":"invited@example.test"}),
            Some(&admin),
        )
        .await;
    let token = invite.value()["token"].as_str().unwrap().to_owned();
    let mut acceptance = account("wrong@example.test");
    acceptance["token"] = json!(token);
    server
        .rpc("auth.acceptInvite", acceptance, None)
        .await
        .error(403, "access.denied");
    // A credential-write failure must roll back product identity and invite consumption.
    server.state.db.execute_unprepared("CREATE FUNCTION hyori_test_fail_credentials() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM hyori_users WHERE id=NEW.user_id AND email='invited@example.test') THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER hyori_test_fail BEFORE INSERT ON hyori_credentials FOR EACH ROW EXECUTE FUNCTION hyori_test_fail_credentials()").await.unwrap();
    let mut acceptance = account("invited@example.test");
    acceptance["token"] = json!(token);
    let failed = server
        .rpc("auth.acceptInvite", acceptance.clone(), None)
        .await;
    assert_ne!(failed.status, 200);
    assert!(!failed.body.to_string().contains("fixture failure"));
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS count FROM hyori_users WHERE email='invited@example.test'",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    server.state.db.execute_unprepared("DROP TRIGGER hyori_test_fail ON hyori_credentials; DROP FUNCTION hyori_test_fail_credentials()").await.unwrap();
    let (one, two) = tokio::join!(
        server.rpc("auth.acceptInvite", acceptance.clone(), None),
        server.rpc("auth.acceptInvite", acceptance.clone(), None)
    );
    let (accepted, replay) = if one.status == 200 {
        (one, two)
    } else {
        (two, one)
    };
    accepted.value();
    replay.error(403, "access.denied");
    server
        .rpc("auth.acceptInvite", acceptance, None)
        .await
        .error(403, "access.denied");
    let invited_cookie = accepted.credential();
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&invited_cookie))
            .await
            .value()["user"]["email"],
        "invited@example.test"
    );
    // Current account state is reloaded; role never grants ordinary owner capability.
    let tx = hyori_server::db::begin(&server.state.db).await.unwrap();
    let actor = server
        .state
        .auth
        .require_actor(&tx, Some(admin.split_once('=').unwrap().1))
        .await
        .unwrap();
    assert!(
        actor
            .require_owner(&hyori_server::features::auth::api::Id(guest_id.clone()))
            .is_err()
    );
    tx.commit().await.unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![guest_id.into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&guest_cookie))
            .await
            .value()["user"],
        Value::Null
    );
    server
        .rpc(
            "auth.login",
            json!({"email":"guest@example.test","password":"correct horse battery staple"}),
            None,
        )
        .await
        .error(401, "auth.invalidCredentials");
    let fresh = TestServer::start(postgres.config.clone()).await;
    assert_eq!(
        fresh
            .rpc("auth.status", json!({}), Some(&admin))
            .await
            .value()["initialized"],
        true
    );
    assert_eq!(
        fresh
            .rpc("auth.status", json!({}), Some(&invited_cookie))
            .await
            .value()["user"]["email"],
        "invited@example.test"
    );
    for _ in 0..10 {
        fresh
            .state
            .auth
            .rate_limit(
                &fresh.state.db,
                "persistent-rate-test",
                hyori_server::auth::SECRET_ATTEMPTS,
            )
            .await
            .unwrap();
    }
    assert!(
        server
            .state
            .auth
            .rate_limit(
                &server.state.db,
                "persistent-rate-test",
                hyori_server::auth::SECRET_ATTEMPTS
            )
            .await
            .is_err()
    );
    let mut invalid_quota = account("badquota@example.test");
    invalid_quota["quotaBytes"] = json!(9007199254740992_u64);
    server
        .rpc("admin.createUser", invalid_quota, Some(&admin))
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "auth.setup",
            json!({"email":"x", "name":"", "password":"x", "setupToken":"x"}),
            None,
        )
        .await
        .error(400, "input.invalid");
    assert_eq!(
        server
            .rpc("files.list", json!({}), Some(&admin))
            .await
            .value()["items"],
        json!([])
    );
    server
        .rpc("not.real", json!({}), Some(&admin))
        .await
        .error(404, "resource.notFound");
    let crossed = server
        .client
        .post(format!("{}/api/rpc", server.url))
        .header("origin", "https://attacker.test")
        .header("host", "localhost:3001")
        .json(&json!({"operation":"auth.logout","input":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(crossed.status(), 403);
    let malformed = server
        .client
        .post(format!("{}/api/rpc", server.url))
        .header("origin", "http://localhost:3001")
        .header("host", "localhost:3001")
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), 400);
    let oversized = server
        .client
        .post(format!("{}/api/rpc", server.url))
        .header("origin", "http://localhost:3001")
        .header("host", "localhost:3001")
        .header("content-type", "application/json")
        .body("x".repeat(256 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), 400);
    assert_eq!(
        server
            .client
            .post(format!("{}/api/auth/sign-up/email", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        server
            .client
            .get(format!("{}/health/ready", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_sessions SET expires_at=now()-interval '1 second' WHERE token_digest=$1",
            vec![digest(invited_cookie.split_once('=').unwrap().1).into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        fresh
            .rpc("auth.status", json!({}), Some(&invited_cookie))
            .await
            .value()["user"],
        Value::Null
    );
    // Wrong setup tokens are refused without an attempt counter, in every process.
    for _ in 0..12 {
        let mut denied = account("nobody@example.test");
        denied["setupToken"] = json!("wrong");
        server
            .rpc("auth.setup", denied, None)
            .await
            .error(403, "auth.setupDenied");
    }
    let mut denied = account("nobody@example.test");
    denied["setupToken"] = json!("wrong");
    fresh
        .rpc("auth.setup", denied, None)
        .await
        .error(403, "auth.setupDenied");
    drop(fresh);
    postgres.stop();
    assert_eq!(
        server
            .client
            .get(format!("{}/health/live", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        server
            .client
            .get(format!("{}/health/ready", server.url))
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    server
        .rpc("auth.status", json!({}), None)
        .await
        .error(503, "service.unavailable");
}

#[tokio::test]
#[ignore = "starts a unique loopback Docker PostgreSQL container; run with --ignored"]
async fn unfinished_request_bodies_do_not_hold_rpc_admission() {
    use tokio::io::AsyncWriteExt;
    let postgres = Postgres::start().await;
    let server = TestServer::start(postgres.config.clone()).await;
    let address = server.url.trim_start_matches("http://").to_owned();
    // Anonymous clients that announce a body and never finish sending it.
    let mut stalled = vec![];
    for _ in 0..hyori_server::config::RPC_CONCURRENCY {
        let mut stream = tokio::net::TcpStream::connect(&address).await.unwrap();
        let head = format!(
            "POST /api/rpc HTTP/1.1\r\nhost: localhost:3001\r\norigin: {}\r\ncontent-type: application/json\r\ncontent-length: 1024\r\n\r\n{{",
            postgres.config.origin
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stalled.push(stream);
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    server.rpc("auth.status", json!({}), None).await.value();
    drop(stalled);
}

#[tokio::test]
#[ignore = "starts a unique loopback Docker PostgreSQL container; run with --ignored"]
async fn migrations_refuse_foreign_data_without_touching_it() {
    let postgres = Postgres::start().await;
    let db = hyori_server::db::connect(&postgres.config).await.unwrap();
    db.execute_unprepared("CREATE TABLE existing_data (id integer PRIMARY KEY); INSERT INTO existing_data VALUES (42)").await.unwrap();
    assert!(hyori_server::db::migrate(&db).await.is_err());
    let row = db
        .query_one_raw(sql("SELECT id FROM existing_data", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i32>("", "id").unwrap(), 42);
    db.close().await.unwrap();
}

#[tokio::test]
#[ignore = "real PostgreSQL bounded authentication cleanup across independent pools"]
async fn authentication_cleanup_is_bounded_restart_safe_and_preserves_live_authority() {
    use hyori_server::{
        AppState,
        maintenance::{AUTH_BATCH_SIZE, AuthCleanup, reclaim_auth},
    };
    let postgres = Postgres::start().await;
    let server = TestServer::start(postgres.config.clone()).await;
    let mut setup = account("cleanup@example.test");
    setup["setupToken"] = json!(postgres.config.setup_token);
    let created = server.rpc("auth.setup", setup, None).await;
    let owner = created.value()["id"].as_str().unwrap().to_owned();
    let admin = created.credential();
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Cleanup"}),
            Some(&admin),
        )
        .await;
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":folder.value()["id"],"public":true,"role":"viewer"}),
            Some(&admin),
        )
        .await;
    let share_id = share.value()["id"].as_str().unwrap().to_owned();
    let token = share.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let resolved = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    resolved.value();
    let guest = resolved.credential();
    let db = &server.state.db;
    let total = AUTH_BATCH_SIZE * 2 + 3;
    for statement in [
        "INSERT INTO hyori_sessions(id,token_digest,user_id,created_at,expires_at) SELECT 'stale_session_'||n,repeat(md5('session'||n),2),$1,now()-interval '2 days',now()-interval '1 day' FROM generate_series(1,$2::bigint) n",
        "INSERT INTO hyori_invites(token_digest,issuer_id,created_at,expires_at) SELECT repeat(md5('invite'||n),2),$1,now()-interval '2 days',now()-interval '1 day' FROM generate_series(1,$2::bigint) n",
    ] {
        db.execute_raw(sql(statement, vec![owner.clone().into(), total.into()]))
            .await
            .unwrap();
    }
    db.execute_raw(sql("INSERT INTO hyori_grants(token_digest,share_id,created_at,expires_at) SELECT repeat(md5('grant'||n),2),$1,now()-interval '1 day',now()-interval '13 hours' FROM generate_series(1,$2::bigint) n", vec![share_id.into(),total.into()])).await.unwrap();
    db.execute_raw(sql("INSERT INTO hyori_rate_limits(key_digest,window_start,attempts) SELECT repeat(md5('rate'||n),2),now()-interval '16 minutes',11 FROM generate_series(1,$1::bigint) n", vec![total.into()])).await.unwrap();
    for _ in 0..10 {
        server
            .state
            .auth
            .rate_limit(
                db,
                "cleanup-live-window",
                hyori_server::auth::SECRET_ATTEMPTS,
            )
            .await
            .unwrap();
    }
    db.execute_unprepared("ALTER TABLE hyori_rate_limits RENAME TO fixture_limits_unavailable")
        .await
        .unwrap();
    assert!(reclaim_auth(db).await.is_err());
    db.execute_unprepared("ALTER TABLE fixture_limits_unavailable RENAME TO hyori_rate_limits")
        .await
        .unwrap();
    let expired = db.query_one_raw(sql("SELECT count(*) AS count FROM hyori_sessions WHERE expires_at <= statement_timestamp()", vec![])).await.unwrap().unwrap();
    assert_eq!(expired.try_get::<i64>("", "count").unwrap(), total);
    let batch = u64::try_from(AUTH_BATCH_SIZE).unwrap();
    assert_eq!(
        reclaim_auth(db).await.unwrap(),
        AuthCleanup {
            sessions: batch,
            grants: batch,
            invites: batch,
            rate_limits: batch
        }
    );
    let restarted = AppState::connect(postgres.config.clone()).await.unwrap();
    assert_eq!(
        reclaim_auth(&restarted.db).await.unwrap(),
        AuthCleanup {
            sessions: batch,
            grants: batch,
            invites: batch,
            rate_limits: batch
        }
    );
    assert_eq!(
        reclaim_auth(db).await.unwrap(),
        AuthCleanup {
            sessions: 3,
            grants: 3,
            invites: 3,
            rate_limits: 3
        }
    );
    assert_eq!(reclaim_auth(db).await.unwrap(), AuthCleanup::default());
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&admin))
            .await
            .value()["user"]["id"],
        owner
    );
    assert_eq!(
        server
            .rpc(
                "files.list",
                json!({"parentId":folder.value()["id"]}),
                Some(&guest)
            )
            .await
            .value()["folder"]["id"],
        folder.value()["id"]
    );
    assert!(
        server
            .state
            .auth
            .rate_limit(
                db,
                "cleanup-live-window",
                hyori_server::auth::SECRET_ATTEMPTS
            )
            .await
            .is_err()
    );
    // Unauthenticated callers can create rate-limit rows (random invite/link tokens) much faster
    // than one bounded batch per 30-second tick reclaims them, and grants stored before link
    // capabilities can leave a backlog too. A tick keeps reclaiming bounded batches meanwhile.
    let backlog = AUTH_BATCH_SIZE * 8 + 1;
    db.execute_raw(sql("INSERT INTO hyori_rate_limits(key_digest,window_start,attempts) SELECT repeat(md5('backlog'||n),2),now()-interval '16 minutes',1 FROM generate_series(1,$1::bigint) n", vec![backlog.into()])).await.unwrap();
    db.execute_raw(sql("INSERT INTO hyori_grants(token_digest,share_id,created_at,expires_at) SELECT repeat(md5('backlog'||n),2),s.id,now()-interval '1 day',now()-interval '13 hours' FROM generate_series(1,$1::bigint) n, hyori_shares s", vec![backlog.into()])).await.unwrap();
    let expired = "SELECT (SELECT count(*) FROM hyori_rate_limits WHERE window_start <= now()-interval '15 minutes') + (SELECT count(*) FROM hyori_grants WHERE expires_at <= now()) AS count";
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(hyori_server::maintenance::run_auth(db.clone(), stopped));
    let mut remaining = i64::MAX;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        remaining = db
            .query_one_raw(sql(expired, vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "count")
            .unwrap();
        if remaining == 0 {
            break;
        }
    }
    stop.send(true).unwrap();
    worker.await.unwrap();
    assert_eq!(remaining, 0, "one maintenance tick left an expired backlog");
    restarted.db.clone().close().await.unwrap();
    server.state.db.clone().close().await.unwrap();
    drop(server);
    postgres.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL cleanup skips locked refreshes and concurrent workers"]
async fn authentication_cleanup_preserves_concurrent_refreshes_and_cooperates_between_workers() {
    use hyori_server::{
        AppState,
        maintenance::{AuthCleanup, reclaim_auth},
    };
    use sea_orm::TransactionTrait;
    let postgres = Postgres::start().await;
    let state = AppState::connect(postgres.config.clone()).await.unwrap();
    let db = &state.db;
    let key = digest("refresh-in-progress");
    db.execute_raw(sql("INSERT INTO hyori_rate_limits(key_digest,window_start,attempts) VALUES ($1,now()-interval '16 minutes',11)", vec![key.clone().into()])).await.unwrap();
    let refresh = db.begin().await.unwrap();
    refresh
        .execute_raw(sql(
            "UPDATE hyori_rate_limits SET window_start=now(),attempts=10 WHERE key_digest=$1",
            vec![key.clone().into()],
        ))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), reclaim_auth(db))
            .await
            .unwrap()
            .unwrap(),
        AuthCleanup::default()
    );
    refresh.commit().await.unwrap();
    let restarted = AppState::connect(postgres.config.clone()).await.unwrap();
    db.execute_raw(sql("INSERT INTO hyori_rate_limits(key_digest,window_start,attempts) SELECT repeat(md5('parallel'||n),2),now()-interval '16 minutes',1 FROM generate_series(1,400) n", vec![])).await.unwrap();
    let (one, two) = tokio::join!(reclaim_auth(db), reclaim_auth(&restarted.db));
    assert_eq!(one.unwrap().rate_limits + two.unwrap().rate_limits, 400);
    assert_eq!(reclaim_auth(db).await.unwrap(), AuthCleanup::default());
    let current = db
        .query_one_raw(sql(
            "SELECT attempts FROM hyori_rate_limits WHERE key_digest=$1",
            vec![key.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.try_get::<i32>("", "attempts").unwrap(), 10);
    state
        .auth
        .rate_limit(
            db,
            "refresh-in-progress",
            hyori_server::auth::SECRET_ATTEMPTS,
        )
        .await
        .unwrap_err();
    restarted.db.clone().close().await.unwrap();
    state.db.clone().close().await.unwrap();
    postgres.stop();
}

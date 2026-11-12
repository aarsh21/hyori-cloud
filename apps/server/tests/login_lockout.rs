mod support;

use hyori_server::auth::random_token;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real PostgreSQL login rate limits: strangers' failures cannot lock out a known device"]
async fn failed_logins_by_others_do_not_lock_out_a_browser_that_signed_in_before() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":server.state.config.setup_token}), None).await.credential();
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":"victim@example.test","name":"Victim","password":password}),
            Some(&admin),
        )
        .await
        .value();
    let signed_in = server
        .rpc(
            "auth.login",
            json!({"email":"victim@example.test","password":password}),
            None,
        )
        .await;
    signed_in.value();
    assert!(
        signed_in
            .cookie
            .as_deref()
            .is_some_and(|cookie| cookie.starts_with("hyori_session="))
    );
    let device = signed_in
        .cookies
        .iter()
        .find(|cookie| cookie.starts_with("hyori_device="))
        .expect("a successful login issues a device cookie");
    assert!(device.contains("HttpOnly") && device.contains("Path=/api/rpc"));
    let device = device.split(';').next().unwrap().to_owned();

    // A stranger exhausts the victim's budget for unknown browsers (the sign-in above used one).
    for _ in 0..9 {
        server
            .rpc(
                "auth.login",
                json!({"email":"victim@example.test","password":"wrong-password"}),
                None,
            )
            .await
            .error(401, "auth.invalidCredentials");
    }
    let unknown = json!({"email":"victim@example.test","password":password});
    server
        .rpc("auth.login", unknown.clone(), None)
        .await
        .error(429, "auth.rateLimited");
    // A forged or other-email device cookie is just an unknown browser.
    let forged = format!("hyori_device={}.{}", random_token(), random_token());
    server
        .rpc("auth.login", unknown.clone(), Some(&forged))
        .await
        .error(429, "auth.rateLimited");
    // The victim's own browser still signs in, and has its own bounded budget.
    server
        .rpc("auth.login", unknown.clone(), Some(&device))
        .await
        .value();
    for _ in 0..9 {
        server
            .rpc(
                "auth.login",
                json!({"email":"victim@example.test","password":"wrong-password"}),
                Some(&device),
            )
            .await
            .error(401, "auth.invalidCredentials");
    }
    server
        .rpc("auth.login", unknown, Some(&device))
        .await
        .error(429, "auth.rateLimited");
    pg.stop();
}

/// A server behind one proxy at the test client's loopback address, listed or not.
async fn behind_proxy(pg: &Postgres, listed: &str) -> (TestServer, String) {
    let mut config = pg.config.clone();
    config.trusted_proxies = vec![listed.parse().unwrap()];
    let server = TestServer::start(config).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":server.state.config.setup_token}), None).await.credential();
    (server, admin)
}
async fn victim(server: &TestServer, admin: &str) -> (serde_json::Value, serde_json::Value) {
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":"victim@example.test","name":"Victim","password":password}),
            Some(admin),
        )
        .await
        .value();
    (
        json!({"email":"victim@example.test","password":password}),
        json!({"email":"victim@example.test","password":"wrong-password"}),
    )
}

#[tokio::test]
#[ignore = "real PostgreSQL login rate limits: a client address from an unlisted peer is ignored"]
async fn client_addresses_from_an_unlisted_peer_change_no_budget() {
    let pg = Postgres::start().await;
    let (server, admin) = behind_proxy(&pg, "10.0.0.0/8").await;
    let (right, wrong) = victim(&server, &admin).await;
    for n in 0..10 {
        let claimed = format!("203.0.113.{n}");
        server
            .rpc_from(Some(&claimed), "auth.login", wrong.clone(), None)
            .await
            .error(401, "auth.invalidCredentials");
    }
    server
        .rpc_from(Some("198.51.100.9"), "auth.login", right, None)
        .await
        .error(429, "auth.rateLimited");
}

#[tokio::test]
#[ignore = "real PostgreSQL login and secret limits per client behind a listed proxy"]
async fn a_listed_proxy_gives_each_client_its_own_budgets() {
    let pg = Postgres::start().await;
    let mut config = pg.config.clone();
    config.trusted_proxies = vec!["127.0.0.1".parse().unwrap()];
    let server = TestServer::start(config).await;
    // Setup: a stranger's wrong tokens are refused without counting and never lock anyone out.
    let mut setup = json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":"x".repeat(24)});
    for _ in 0..11 {
        server
            .rpc_from(Some("203.0.113.66"), "auth.setup", setup.clone(), None)
            .await
            .error(403, "auth.setupDenied");
    }
    setup["setupToken"] = json!(server.state.config.setup_token);
    let admin = server
        .rpc_from(Some("198.51.100.1"), "auth.setup", setup, None)
        .await
        .credential();
    // Login: one client exhausts its budget; other spellings of it stay limited.
    let (right, wrong) = victim(&server, &admin).await;
    for _ in 0..10 {
        server
            .rpc_from(Some("203.0.113.7"), "auth.login", wrong.clone(), None)
            .await
            .error(401, "auth.invalidCredentials");
    }
    for spelling in [
        "203.0.113.7",
        " 203.0.113.7 ",
        "::ffff:203.0.113.7",
        "::FFFF:CB00:7107",
    ] {
        server
            .rpc_from(Some(spelling), "auth.login", right.clone(), None)
            .await
            .error(429, "auth.rateLimited");
    }
    // A different client behind the same proxy still signs in.
    server
        .rpc_from(Some("198.51.100.9"), "auth.login", right.clone(), None)
        .await
        .value();
    // IPv6 clients are keyed by /64: rotating within it does not reset the budget.
    for _ in 0..10 {
        server
            .rpc_from(Some("2001:db8:1:2::1"), "auth.login", wrong.clone(), None)
            .await
            .error(401, "auth.invalidCredentials");
    }
    for spelling in ["2001:0DB8:1:2:0:0:0:1", "2001:db8:1:2:ffff::9"] {
        server
            .rpc_from(Some(spelling), "auth.login", right.clone(), None)
            .await
            .error(429, "auth.rateLimited");
    }
    server
        .rpc_from(Some("2001:db8:1:3::1"), "auth.login", right.clone(), None)
        .await
        .value();
    // One client's attempts across emails count toward its 100-attempt ceiling, past the 11 the
    // first schema allowed: the 12th once failed the table's check and answered 503.
    for n in 0..12 {
        server
            .rpc_from(
                Some("203.0.113.200"),
                "auth.login",
                json!({"email":format!("nobody{n}@example.test"),"password":"wrong-password"}),
                None,
            )
            .await
            .error(401, "auth.invalidCredentials");
    }
    // Malformed or missing values are no client: they all share one per-email budget.
    for (n, spelling) in ["203.000.113.007", "unknown", "", "203.0.113.7:443"]
        .iter()
        .cycle()
        .take(10)
        .enumerate()
    {
        let reply = if spelling.is_empty() {
            server.rpc("auth.login", wrong.clone(), None).await
        } else {
            server
                .rpc_from(Some(spelling), "auth.login", wrong.clone(), None)
                .await
        };
        assert_eq!(reply.status, 401, "{n} {spelling}: {}", reply.body);
    }
    server
        .rpc_from(Some("[203.0.113.7]"), "auth.login", right.clone(), None)
        .await
        .error(429, "auth.rateLimited");
    // Share unlock: wrong passwords from one client do not lock the link for another.
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Shared"}),
            Some(&admin),
        )
        .await
        .value()["id"]
        .clone();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"role":"viewer","public":true,"password":"link password"}),
            Some(&admin),
        )
        .await
        .value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned();
    for _ in 0..10 {
        server
            .rpc_from(
                Some("203.0.113.7"),
                "shares.unlock",
                json!({"token":link,"password":"not it at all"}),
                None,
            )
            .await
            .error(403, "access.denied");
    }
    server
        .rpc_from(
            Some("203.0.113.7"),
            "shares.unlock",
            json!({"token":link,"password":"link password"}),
            None,
        )
        .await
        .error(429, "auth.rateLimited");
    let unlocked = server
        .rpc_from(
            Some("198.51.100.9"),
            "shares.unlock",
            json!({"token":link,"password":"link password"}),
            None,
        )
        .await;
    assert_eq!(unlocked.value()["requiresPassword"], false);
    // Invites: each client has 10 attempts, and all clients together 100.
    let invite = server
        .rpc(
            "admin.createInvite",
            json!({"email":"invitee@example.test"}),
            Some(&admin),
        )
        .await
        .value()["token"]
        .clone();
    let attempt = |email: &str| json!({"token":invite,"email":email,"name":"Invitee","password":random_token()});
    for client in 0..10 {
        let client = format!("192.0.2.{client}");
        for _ in 0..10 {
            server
                .rpc_from(
                    Some(&client),
                    "auth.acceptInvite",
                    attempt("wrong@example.test"),
                    None,
                )
                .await
                .error(403, "access.denied");
        }
        server
            .rpc_from(
                Some(&client),
                "auth.acceptInvite",
                attempt("invitee@example.test"),
                None,
            )
            .await
            .error(429, "auth.rateLimited");
    }
    server
        .rpc_from(
            Some("192.0.2.200"),
            "auth.acceptInvite",
            attempt("invitee@example.test"),
            None,
        )
        .await
        .error(429, "auth.rateLimited");
}

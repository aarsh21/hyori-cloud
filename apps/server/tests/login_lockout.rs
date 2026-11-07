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

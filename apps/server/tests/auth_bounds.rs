mod support;

use hyori_server::{
    auth::random_token,
    config::Config,
    features::auth::api::{
        NEW_PASSWORD_MIN_CHARS, NewAccount, PASSWORD_MAX_CHARS, SETUP_TOKEN_MAX_CHARS,
        SETUP_TOKEN_MIN_CHARS, Setup,
    },
    wire::decode,
};
use serde_json::json;

fn config_with_token(setup_token: String) -> Config {
    Config {
        database_url: format!(
            "postgres://fixture:{}@127.0.0.1:5432/fixture",
            random_token()
        ),
        origin: "http://localhost:3001".into(),
        setup_token,
        auth_secret: random_token(),
        secure_cookies: false,
        bind: "127.0.0.1:0".parse().unwrap(),
        default_quota_bytes: 1024,
        trash_retention_days: hyori_server::config::DEFAULT_TRASH_RETENTION_DAYS,
        database_max_connections: hyori_server::config::DEFAULT_DATABASE_CONNECTIONS,
        storage: None,
        media_worker_socket: None,
        editor_assets: None,
        trusted_proxies: vec![],
    }
}

fn setup_input(token: &str) -> serde_json::Value {
    json!({"setupToken": token, "email": "bounds@example.test", "name": "Bounds", "password": "A valid test passphrase"})
}

#[test]
fn shortest_configured_setup_token_is_accepted_by_the_wire_contract() {
    let token = "s".repeat(SETUP_TOKEN_MIN_CHARS);
    config_with_token(token.clone()).validate().unwrap();
    assert!(decode::<Setup>(setup_input(&token)).is_ok());
}

#[test]
fn longest_unicode_setup_token_is_accepted_by_configuration_and_wire() {
    let token = "🔐".repeat(SETUP_TOKEN_MAX_CHARS);
    config_with_token(token.clone()).validate().unwrap();
    assert!(decode::<Setup>(setup_input(&token)).is_ok());
}

#[test]
fn oversized_setup_token_fails_configuration_before_bootstrap() {
    let error = config_with_token("s".repeat(SETUP_TOKEN_MAX_CHARS + 1))
        .validate()
        .unwrap_err();
    assert!(error.to_string().contains("HYORI_SETUP_TOKEN"));
}

#[test]
fn setup_token_minimum_counts_characters_instead_of_utf8_bytes() {
    assert!(
        config_with_token("🔐".repeat(SETUP_TOKEN_MIN_CHARS / 4))
            .validate()
            .is_err()
    );
}

#[test]
fn maximum_supplementary_plane_password_is_accepted_by_the_authoritative_schema() {
    let value = json!({"email": "bounds@example.test", "name": "Bounds", "password": "🔐".repeat(PASSWORD_MAX_CHARS)});
    assert!(decode::<NewAccount>(value).is_ok());
}

#[test]
fn password_above_the_code_point_limit_is_rejected_by_the_authoritative_schema() {
    let value = json!({"email": "bounds@example.test", "name": "Bounds", "password": "🔐".repeat(PASSWORD_MAX_CHARS + 1)});
    assert!(decode::<NewAccount>(value).is_err());
}

#[tokio::test]
#[ignore = "real PostgreSQL/Better Auth Unicode boundaries; unique loopback test container"]
async fn accepted_setup_and_unicode_password_bounds_work_through_real_auth_http() {
    let mut postgres = support::Postgres::start().await;
    postgres.config.setup_token = "s".repeat(SETUP_TOKEN_MAX_CHARS);
    let server = support::TestServer::start(postgres.config.clone()).await;
    let setup = server
        .rpc(
            "auth.setup",
            json!({
                "setupToken": postgres.config.setup_token,
                "email": "owner@example.test", "name": "Owner",
                "password": "A".repeat(NEW_PASSWORD_MIN_CHARS)
            }),
            None,
        )
        .await;
    setup.value();
    assert!(setup.cookie.as_deref().is_some_and(
        |cookie| cookie.contains("; HttpOnly") && cookie.contains("; SameSite=Strict")
    ));
    let admin = setup.credential();

    for count in [513, PASSWORD_MAX_CHARS] {
        let email = format!("unicode-{count}@example.test");
        let password = "🔐".repeat(count);
        let created = server
            .rpc(
                "admin.createUser",
                json!({"email": email, "name": "Unicode", "password": password}),
                Some(&admin),
            )
            .await;
        let id = created.value()["id"].as_str().unwrap().to_owned();
        let login = server
            .rpc(
                "auth.login",
                json!({"email": email, "password": password}),
                None,
            )
            .await;
        login.value();
        let status = server
            .rpc("auth.status", json!({}), Some(&login.credential()))
            .await;
        assert_eq!(status.value()["user"]["id"], id);
    }

    let rejected = server.rpc("admin.createUser", json!({
        "email": "oversized@example.test", "name": "Oversized", "password": "🔐".repeat(PASSWORD_MAX_CHARS + 1)
    }), Some(&admin)).await;
    rejected.error(400, "input.invalid");
    server.state.db.clone().close().await.unwrap();
    drop(server);
    postgres.stop();
}

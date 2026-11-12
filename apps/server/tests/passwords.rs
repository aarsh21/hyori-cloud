mod support;

use hyori_server::{
    auth::{digest, random_token},
    db::sql,
};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, TestServer};

async fn fixture() -> (Postgres, TestServer, String, Value, String) {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":random_token(),"setupToken":server.state.config.setup_token}),None).await.credential();
    let password = random_token();
    let user = server
        .rpc(
            "admin.createUser",
            json!({"email":"member@example.test","name":"Member","password":password}),
            Some(&admin),
        )
        .await
        .value()
        .clone();
    (pg, server, admin, user, password)
}

async fn login(server: &TestServer, email: &str, password: &str) -> String {
    let reply = server
        .rpc(
            "auth.login",
            json!({"email":email,"password":password}),
            None,
        )
        .await;
    reply.value();
    assert!(
        reply
            .cookie
            .as_deref()
            .is_some_and(|cookie| cookie.contains("HttpOnly"))
    );
    reply.credential()
}

async fn reset_link(server: &TestServer, admin: &str, user: &Value) -> String {
    server
        .rpc(
            "admin.createPasswordReset",
            json!({"userId":user["id"]}),
            Some(admin),
        )
        .await
        .value()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
#[ignore = "real PostgreSQL password change and session revocation"]
async fn change_requires_current_password_preserves_current_session_and_revokes_others() {
    let (pg, server, admin, user, old) = fixture().await;
    let current = login(&server, "member@example.test", &old).await;
    let other = login(&server, "member@example.test", &old).await;
    let link = reset_link(&server, &admin, &user).await;
    server
        .rpc(
            "auth.changePassword",
            json!({"currentPassword":"wrong password","newPassword":random_token()}),
            Some(&current),
        )
        .await
        .error(401, "auth.invalidCredentials");
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&other))
            .await
            .value()["user"]["id"],
        user["id"]
    );
    let new = random_token();
    server
        .rpc(
            "auth.changePassword",
            json!({"currentPassword":old,"newPassword":new}),
            Some(&current),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&current))
            .await
            .value()["user"]["id"],
        user["id"]
    );
    assert!(
        server
            .rpc("auth.status", json!({}), Some(&other))
            .await
            .value()["user"]
            .is_null()
    );
    server
        .rpc(
            "auth.login",
            json!({"email":"member@example.test","password":old}),
            None,
        )
        .await
        .error(401, "auth.invalidCredentials");
    login(&server, "member@example.test", &new).await;
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":link,"newPassword":random_token()}),
            None,
        )
        .await
        .error(403, "access.denied");
    pg.stop();
}

#[tokio::test]
#[ignore = "real PostgreSQL per-account password-change attempt budget"]
async fn wrong_attempts_survive_rollback_share_an_account_budget_and_expire() {
    let (_pg, server, _admin, user, old) = fixture().await;
    let first = login(&server, "member@example.test", &old).await;
    let second = login(&server, "member@example.test", &old).await;
    let input = json!({"currentPassword":"wrong password","newPassword":random_token()});
    for n in 0..10 {
        server
            .rpc(
                "auth.changePassword",
                input.clone(),
                Some(if n % 2 == 0 { &first } else { &second }),
            )
            .await
            .error(401, "auth.invalidCredentials");
    }
    let new = random_token();
    let right = json!({"currentPassword":old,"newPassword":new});
    server
        .rpc("auth.changePassword", right.clone(), Some(&second))
        .await
        .error(429, "auth.rateLimited");
    // Failed attempts change neither credentials nor sessions; sign-in has an independent budget.
    login(&server, "member@example.test", &old).await;
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&first))
            .await
            .value()["user"]["id"],
        user["id"]
    );
    server.state.db.execute_raw(sql("UPDATE hyori_rate_limits SET window_start=now()-interval '16 minutes' WHERE key_digest=$1",vec![digest(&format!("password-change:{}",user["id"].as_str().unwrap())).into()])).await.unwrap();
    server
        .rpc("auth.changePassword", right, Some(&first))
        .await
        .value();
    login(&server, "member@example.test", &new).await;
}

#[tokio::test]
#[ignore = "real PostgreSQL administrator reset, single use and supersession"]
async fn reset_is_single_use_replaces_earlier_link_and_revokes_every_session() {
    let (_pg, server, admin, user, old) = fixture().await;
    let first_session = login(&server, "member@example.test", &old).await;
    let second_session = login(&server, "member@example.test", &old).await;
    let first = reset_link(&server, &admin, &user).await;
    let second = reset_link(&server, &admin, &user).await;
    assert_ne!(first, second);
    let new = random_token();
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":first,"newPassword":new}),
            None,
        )
        .await
        .error(403, "access.denied");
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&first_session))
            .await
            .value()["user"]["id"],
        user["id"]
    );
    let result = server
        .rpc(
            "auth.resetPassword",
            json!({"token":second,"newPassword":new}),
            None,
        )
        .await
        .value()
        .clone();
    assert_eq!(result, json!({"success":true,"userId":user["id"]}));
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&admin))
            .await
            .value()["user"]["email"],
        "admin@example.test"
    );
    for session in [&first_session, &second_session] {
        assert!(
            server
                .rpc("auth.status", json!({}), Some(session))
                .await
                .value()["user"]
                .is_null()
        );
    }
    server
        .rpc(
            "auth.login",
            json!({"email":"member@example.test","password":old}),
            None,
        )
        .await
        .error(401, "auth.invalidCredentials");
    login(&server, "member@example.test", &new).await;
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":second,"newPassword":random_token()}),
            None,
        )
        .await
        .error(403, "access.denied");
}

#[tokio::test]
#[ignore = "real PostgreSQL reset expiry, deletion and password policy"]
async fn expired_links_and_deleted_accounts_are_refused_without_consuming_valid_links_on_bad_input()
{
    let (_pg, server, admin, user, old) = fixture().await;
    let link = reset_link(&server, &admin, &user).await;
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":link,"newPassword":"short"}),
            None,
        )
        .await
        .error(400, "input.invalid");
    let session = login(&server, "member@example.test", &old).await;
    server
        .rpc(
            "auth.changePassword",
            json!({"currentPassword":old,"newPassword":"short"}),
            Some(&session),
        )
        .await
        .error(400, "input.invalid");
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT token_digest,extract(epoch FROM expires_at-created_at)::bigint AS seconds FROM hyori_password_resets WHERE user_id=$1",
            vec![user["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "seconds").unwrap(), 86_400);
    assert_eq!(
        row.try_get::<String>("", "token_digest").unwrap(),
        digest(&link)
    );
    server.state.db.execute_raw(sql("UPDATE hyori_password_resets SET expires_at=now()-interval '1 second' WHERE user_id=$1",vec![user["id"].as_str().unwrap().into()])).await.unwrap();
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":link,"newPassword":random_token()}),
            None,
        )
        .await
        .error(403, "access.denied");
    let link = reset_link(&server, &admin, &user).await;
    server
        .rpc(
            "admin.deleteUser",
            json!({"userId":user["id"],"confirmEmail":"member@example.test"}),
            Some(&admin),
        )
        .await
        .value();
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":link,"newPassword":random_token()}),
            None,
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "admin.createPasswordReset",
            json!({"userId":user["id"]}),
            Some(&admin),
        )
        .await
        .error(403, "access.denied");
    // Represent the later tombstone phase without involving unrelated object-store cleanup.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleted' WHERE id=$1",
            vec![user["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "auth.resetPassword",
            json!({"token":link,"newPassword":random_token()}),
            None,
        )
        .await
        .error(403, "access.denied");
}

#[tokio::test]
#[ignore = "real PostgreSQL password authority belongs only to the session account"]
async fn non_admin_cannot_issue_resets_and_cannot_change_another_accounts_password() {
    let (_pg, server, admin, user, old) = fixture().await;
    let member = login(&server, "member@example.test", &old).await;
    let another_password = random_token();
    let another = server
        .rpc(
            "admin.createUser",
            json!({"email":"another@example.test","name":"Another","password":another_password}),
            Some(&admin),
        )
        .await
        .value()
        .clone();
    server
        .rpc(
            "admin.createPasswordReset",
            json!({"userId":user["id"]}),
            Some(&member),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "auth.changePassword",
            json!({"currentPassword":old,"newPassword":random_token()}),
            None,
        )
        .await
        .error(401, "auth.required");
    // No target account exists in the contract. A forged target never selects another credential.
    let new = random_token();
    server
        .rpc(
            "auth.changePassword",
            json!({"userId":another["id"],"currentPassword":old,"newPassword":new}),
            Some(&member),
        )
        .await
        .value();
    login(&server, "member@example.test", &new).await;
    login(&server, "another@example.test", &another_password).await;
}

#[tokio::test]
#[ignore = "real PostgreSQL concurrent reset redemption"]
async fn simultaneous_redemption_has_exactly_one_winner() {
    let (_pg, server, admin, user, _old) = fixture().await;
    let token = reset_link(&server, &admin, &user).await;
    let a = random_token();
    let b = random_token();
    let (first, second) = tokio::join!(
        server.rpc(
            "auth.resetPassword",
            json!({"token":token,"newPassword":a}),
            None
        ),
        server.rpc(
            "auth.resetPassword",
            json!({"token":token,"newPassword":b}),
            None
        )
    );
    let winner = match (first.status, second.status) {
        (200, 403) => a,
        (403, 200) => b,
        status => panic!(
            "expected one winner: {status:?}, {}, {}",
            first.body, second.body
        ),
    };
    login(&server, "member@example.test", &winner).await;
}

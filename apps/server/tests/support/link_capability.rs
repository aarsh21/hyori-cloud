//! Link capabilities as a browser holds them, for tests of public links.
use super::support::TestServer;
use sea_orm::ConnectionTrait;

/// A capability for `share_id`, made with the link's current password, that expired a second
/// ago: what a browser holds after the 12 hours.
pub async fn expired(server: &TestServer, share_id: &str) -> String {
    let row = server
        .state
        .db
        .query_one_raw(hyori_server::db::sql(
            "SELECT password_hash FROM hyori_shares WHERE id=$1",
            vec![share_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    let hash: Option<String> = row.try_get("", "password_hash").unwrap();
    let now = chrono::Utc::now().timestamp();
    hyori_server::features::shares::capability::mint(
        &server.state.config.auth_secret,
        share_id,
        hash.as_deref(),
        now - 60,
        now - 1,
    )
}
/// The issue and expiry Unix seconds of a link capability cookie value.
pub fn times(value: &str) -> (i64, i64) {
    let parts: Vec<_> = value.split('.').collect();
    assert_eq!(parts.len(), 6, "not a link capability: {value}");
    (parts[3].parse().unwrap(), parts[4].parse().unwrap())
}

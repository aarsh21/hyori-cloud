//! Stateless public-link capabilities. Opening a link stores nothing: the visitor's cookie holds
//! the share, a random visitor nonce, the issue and expiry times, and a MAC over those and the
//! link's current password hash. Every operation still rechecks the link's revocation, expiry and
//! issuer in the database; this only replaces the stored per-visitor grant row.
use crate::auth::hmac_sha256;
use chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;

/// The longest a capability lives; a link that expires sooner caps it.
pub(crate) const LIFETIME_SECONDS: i64 = 12 * 60 * 60;
const VERSION: &str = "c1";

/// The capability MAC key, derived from `HYORI_AUTH_SECRET` under its own label so it never
/// equals a key used for anything else.
pub(crate) fn key(secret: &str) -> [u8; 32] {
    hmac_sha256(secret.as_bytes(), b"hyori-link-capability-v1")
}

/// A capability in its written form, `c1.<share>.<nonce>.<issued>.<expires>.<mac>`; parsing
/// checks its shape only.
pub(crate) struct Capability<'a> {
    pub share_id: &'a str,
    nonce: &'a str,
    /// Unix seconds.
    pub issued: i64,
    /// Unix seconds.
    pub expires: i64,
    mac: &'a str,
}
impl<'a> Capability<'a> {
    pub fn parse(token: &'a str) -> Option<Self> {
        let mut parts = token.split('.');
        let (
            Some(VERSION),
            Some(share_id),
            Some(nonce),
            Some(issued),
            Some(expires),
            Some(mac),
            None,
        ) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        )
        else {
            return None;
        };
        let seconds = |value: &str| -> Option<i64> {
            ((1..=12).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()))
                .then(|| value.parse().ok())
                .flatten()
        };
        let id_like = (1..=128).contains(&share_id.len())
            && share_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !(id_like && hex(nonce, 32) && hex(mac, 64)) {
            return None;
        }
        Some(Self {
            share_id,
            nonce,
            issued: seconds(issued)?,
            expires: seconds(expires)?,
            mac,
        })
    }
    /// Whether this server issued it for the link as it is now, with this password hash. Expiry
    /// is not checked here: see [`Self::live`].
    pub fn verifies(&self, key: &[u8; 32], password_hash: Option<&str>) -> bool {
        let lifetime = self.expires - self.issued;
        (1..=LIFETIME_SECONDS).contains(&lifetime)
            && bool::from(
                mac(
                    key,
                    self.share_id,
                    self.nonce,
                    self.issued,
                    self.expires,
                    password_hash,
                )
                .as_bytes()
                .ct_eq(self.mac.as_bytes()),
            )
    }
    pub fn live(&self, now: DateTime<Utc>) -> bool {
        self.expires > now.timestamp()
    }
    pub fn issued_at(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.issued, 0).unwrap_or_default()
    }
    pub fn expires_at(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.expires, 0).unwrap_or_default()
    }
}
/// A new capability for a visitor of `share_id`, living [`LIFETIME_SECONDS`] or until the link
/// expires, whichever is first, with its remaining seconds.
pub(crate) fn issue(
    key: &[u8; 32],
    share_id: &str,
    password_hash: Option<&str>,
    link_expiry: Option<DateTime<Utc>>,
) -> (String, i64) {
    let issued = Utc::now().timestamp();
    let expires = link_expiry
        .map_or(issued + LIFETIME_SECONDS, |expiry| {
            expiry.timestamp().min(issued + LIFETIME_SECONDS)
        })
        .max(issued + 1);
    (
        written(key, share_id, password_hash, issued, expires),
        expires - issued,
    )
}
/// A capability with chosen times, as [`issue`] writes them. For tests and tools that hold
/// `HYORI_AUTH_SECRET`, such as ones that need an already expired capability.
pub fn mint(
    secret: &str,
    share_id: &str,
    password_hash: Option<&str>,
    issued: i64,
    expires: i64,
) -> String {
    written(&key(secret), share_id, password_hash, issued, expires)
}
fn written(
    key: &[u8; 32],
    share_id: &str,
    password_hash: Option<&str>,
    issued: i64,
    expires: i64,
) -> String {
    let nonce = &crate::auth::random_token()[..32];
    let mac = mac(key, share_id, nonce, issued, expires, password_hash);
    format!("{VERSION}.{share_id}.{nonce}.{issued}.{expires}.{mac}")
}
fn mac(
    key: &[u8; 32],
    share_id: &str,
    nonce: &str,
    issued: i64,
    expires: i64,
    password_hash: Option<&str>,
) -> String {
    let password = password_hash.map_or_else(|| "none".to_owned(), |hash| format!("hash:{hash}"));
    let message = format!("{share_id}\0{nonce}\0{issued}\0{expires}\0{password}");
    hex::encode(hmac_sha256(key, message.as_bytes()))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    const SHARE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn a_capability_verifies_only_for_its_share_key_and_password() {
        let key = key("test-secret-with-at-least-thirty-two-bytes");
        let (token, remaining) = issue(&key, SHARE, Some("salt:hash"), None);
        assert_eq!(remaining, LIFETIME_SECONDS);
        let capability = Capability::parse(&token).unwrap();
        assert!(capability.verifies(&key, Some("salt:hash")));
        assert!(capability.live(Utc::now()));
        assert!(!capability.verifies(&key, Some("salt:other")));
        assert!(!capability.verifies(&key, None));
        let other = super::key("another-secret-with-at-least-thirty-two");
        assert!(!capability.verifies(&other, Some("salt:hash")));
        // Moving it to another share, or stretching its life, breaks the MAC.
        let moved = token.replacen(SHARE, &"f".repeat(64), 1);
        assert!(
            !Capability::parse(&moved)
                .unwrap()
                .verifies(&key, Some("salt:hash"))
        );
        let expires = capability.expires.to_string();
        let stretched = token.replacen(&expires, &(capability.expires + 60).to_string(), 1);
        assert!(
            !Capability::parse(&stretched)
                .unwrap()
                .verifies(&key, Some("salt:hash"))
        );
    }
    #[test]
    fn a_link_expiring_sooner_caps_the_capability() {
        let key = key("test-secret-with-at-least-thirty-two-bytes");
        let soon = Utc::now() + chrono::Duration::minutes(5);
        let (token, remaining) = issue(&key, SHARE, None, Some(soon));
        assert!((299..=300).contains(&remaining));
        assert_eq!(Capability::parse(&token).unwrap().expires, soon.timestamp());
    }
    #[test]
    fn malformed_capabilities_do_not_parse() {
        let key = key("test-secret-with-at-least-thirty-two-bytes");
        let (token, _) = issue(&key, SHARE, None, None);
        for bad in [
            token.replacen("c1.", "c2.", 1),
            format!("{token}.x"),
            token.replacen(SHARE, "", 1),
            token.to_uppercase(),
            "a".repeat(64),
        ] {
            assert!(Capability::parse(&bad).is_none(), "{bad}");
        }
    }
}

use crate::features::auth::api::{SETUP_TOKEN_MAX_CHARS, SETUP_TOKEN_MIN_CHARS};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use url::Url;

#[derive(Clone)]
pub struct EditorAssetsConfig {
    pub directory: std::path::PathBuf,
    pub manifest_sha256: String,
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub origin: String,
    pub setup_token: String,
    pub auth_secret: String,
    pub secure_cookies: bool,
    pub bind: SocketAddr,
    pub default_quota_bytes: u64,
    /// Trash roots older than this are permanently deleted by maintenance (1 to 3650 days).
    pub trash_retention_days: u32,
    /// PostgreSQL pool ceiling per process; see [`DEFAULT_DATABASE_CONNECTIONS`].
    pub database_max_connections: u32,
    /// None is an explicit metadata-only fixture; storage operations return unavailable.
    pub storage: Option<hyori_storage::StorageConfig>,
    /// Operator-owned private Unix capability; absence disables derivative processing, not originals.
    pub media_worker_socket: Option<std::path::PathBuf>,
    /// Explicit operator-selected, pinned read-only editor bundle; absence disables runtime editing.
    pub editor_assets: Option<EditorAssetsConfig>,
    /// Peers whose `x-hyori-client-address` names the end client (`HYORI_TRUSTED_PROXIES`).
    /// Empty: the header is ignored and only a public TCP peer identifies a client.
    pub trusted_proxies: Vec<ProxyRange>,
    /// How long after a sign-in request arrived every failed sign-in is answered. Always
    /// [`SIGN_IN_ANSWER`] in a deployment; tests shorten it.
    pub sign_in_answer: Duration,
}
/// One address or CIDR range of `HYORI_TRUSTED_PROXIES`, such as `10.0.0.0/8` or `::1`.
/// IPv4-mapped IPv6 peers match IPv4 ranges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProxyRange {
    network: IpAddr,
    prefix: u8,
}
impl ProxyRange {
    pub fn contains(&self, address: IpAddr) -> bool {
        let address = address.to_canonical();
        address.is_ipv4() == self.network.is_ipv4() && network(address, self.prefix) == self.network
    }
}
/// The lowest address of the `prefix`-bit network containing `address`.
pub(crate) fn network(address: IpAddr, prefix: u8) -> IpAddr {
    let keep = |width: u8| {
        u128::MAX
            .checked_shl(u32::from(width.saturating_sub(prefix)))
            .unwrap_or(0)
    };
    match address {
        IpAddr::V4(address) => IpAddr::V4((u32::from(address) & keep(32) as u32).into()),
        IpAddr::V6(address) => IpAddr::V6((u128::from(address) & keep(128)).into()),
    }
}
impl std::str::FromStr for ProxyRange {
    type Err = ConfigError;
    /// Refuses a range with host bits set or one covering every address: both are likely typos.
    fn from_str(value: &str) -> Result<Self, ConfigError> {
        let invalid =
            || ConfigError("HYORI_TRUSTED_PROXIES entries must be addresses or CIDR ranges");
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (value, None),
        };
        let address: IpAddr = address.parse().map_err(|_| invalid())?;
        let width = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => width,
            Some(digits)
                if (1..=3).contains(&digits.len())
                    && digits.bytes().all(|b| b.is_ascii_digit()) =>
            {
                digits.parse().map_err(|_| invalid())?
            }
            Some(_) => return Err(invalid()),
        };
        if address.to_canonical() != address
            || !(1..=width).contains(&prefix)
            || network(address, prefix) != address
        {
            return Err(invalid());
        }
        Ok(Self {
            network: address,
            prefix,
        })
    }
}
#[derive(Debug, thiserror::Error)]
#[error("Invalid server configuration: {0}")]
pub struct ConfigError(&'static str);
pub const DEFAULT_TRASH_RETENTION_DAYS: u32 = 30;
/// Concurrent RPC handlers admitted per process; excess requests receive `service.unavailable`.
pub const RPC_CONCURRENCY: usize = 128;
/// Concurrent download/preview/thumbnail/editor-download bodies per process.
pub const DOWNLOAD_CONCURRENCY: usize = 64;
/// Concurrent download bodies per session, public-grant set or client address.
pub const DOWNLOADS_PER_PRINCIPAL: usize = 8;
/// Further requests per principal that may wait for one of its slots instead of failing.
pub const DOWNLOAD_QUEUE_PER_PRINCIPAL: usize = 56;
/// How long a queued download request waits for its principal's slot before `503`.
pub const DOWNLOAD_QUEUE_WAIT: Duration = Duration::from_secs(10);
/// Concurrent upload begin/part/complete operations per process.
pub const UPLOAD_CONCURRENCY: usize = 16;
/// An RPC holds at most one connection at a time and most release it within milliseconds, so a
/// quarter of the RPC slots plus every upload operation (each holds one across its storage call's
/// bracketing transactions) keeps admitted work from timing out on pool acquisition. Downloads only
/// use a connection while authorizing. Operators sharing PostgreSQL across replicas lower this.
pub const DEFAULT_DATABASE_CONNECTIONS: u32 = (RPC_CONCURRENCY / 4 + UPLOAD_CONCURRENCY) as u32;
/// Every failed sign-in is answered this long after its request arrived, whether the email has
/// no account, the password is wrong or its check did not finish in time, so neither the answer
/// nor its timing tells them apart. About 40 times one verification (see `auth::password`).
pub const SIGN_IN_ANSWER: Duration = Duration::from_secs(3);
pub const SESSION_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const MAX_JSON_BYTES: usize = 256 * 1024;
pub const DATABASE_TIMEOUT: Duration = Duration::from_secs(10);
impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let required = |name| {
            std::env::var(name).map_err(|_| ConfigError("required environment variable missing"))
        };
        let production = match std::env::var("APP_ENV").as_deref() {
            Ok("production") => true,
            Ok("development") => false,
            _ => {
                return Err(ConfigError(
                    "APP_ENV must explicitly be development or production",
                ));
            }
        };
        let config = Self {
            database_url: required("HYORI_DATABASE_URL")?,
            origin: required("APP_ORIGIN")?,
            setup_token: required("HYORI_SETUP_TOKEN")?,
            auth_secret: required("HYORI_AUTH_SECRET")?,
            secure_cookies: production,
            bind: std::env::var("HYORI_SERVER_BIND")
                .unwrap_or_else(|_| "127.0.0.1:3002".into())
                .parse()
                .map_err(|_| ConfigError("invalid bind address"))?,
            default_quota_bytes: 10 * 1024 * 1024 * 1024,
            trash_retention_days: match std::env::var("HYORI_TRASH_RETENTION_DAYS") {
                Err(std::env::VarError::NotPresent) => DEFAULT_TRASH_RETENTION_DAYS,
                value => value
                    .ok()
                    .and_then(|days| days.parse().ok())
                    .ok_or(ConfigError(
                        "trash retention must be a whole number of days",
                    ))?,
            },
            database_max_connections: match std::env::var("HYORI_DATABASE_MAX_CONNECTIONS") {
                Err(std::env::VarError::NotPresent) => DEFAULT_DATABASE_CONNECTIONS,
                value => value
                    .ok()
                    .and_then(|count| count.parse().ok())
                    .ok_or(ConfigError(
                        "database pool size must be a whole number of connections",
                    ))?,
            },
            media_worker_socket: std::env::var_os("HYORI_MEDIA_WORKER_SOCKET").map(Into::into),
            trusted_proxies: match std::env::var("HYORI_TRUSTED_PROXIES") {
                Err(std::env::VarError::NotPresent) => vec![],
                value => value
                    .map_err(|_| ConfigError("HYORI_TRUSTED_PROXIES must be text"))?
                    .split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::parse)
                    .collect::<Result<_, _>>()?,
            },
            sign_in_answer: SIGN_IN_ANSWER,
            editor_assets: match (
                std::env::var_os("HYORI_EDITOR_ASSETS_DIR"),
                std::env::var("HYORI_EDITOR_ASSETS_MANIFEST_SHA256"),
            ) {
                (None, Err(std::env::VarError::NotPresent)) => None,
                (Some(directory), Ok(manifest_sha256)) => Some(EditorAssetsConfig {
                    directory: directory.into(),
                    manifest_sha256,
                }),
                _ => {
                    return Err(ConfigError(
                        "editor assets directory and manifest SHA-256 must be configured together",
                    ));
                }
            },
            storage: if [
                "HYORI_STORAGE_ENDPOINT",
                "HYORI_STORAGE_REGION",
                "HYORI_STORAGE_BUCKET",
                "HYORI_STORAGE_ACCESS_KEY",
                "HYORI_STORAGE_SECRET_KEY",
            ]
            .iter()
            .any(|name| std::env::var_os(name).is_some())
            {
                Some(hyori_storage::StorageConfig {
                    endpoint: required("HYORI_STORAGE_ENDPOINT")?,
                    region: required("HYORI_STORAGE_REGION")?,
                    bucket: required("HYORI_STORAGE_BUCKET")?,
                    access_key_id: required("HYORI_STORAGE_ACCESS_KEY")?,
                    secret_access_key: required("HYORI_STORAGE_SECRET_KEY")?,
                })
            } else {
                None
            },
        };
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.editor_assets.as_ref().is_some_and(|assets| {
            !assets.directory.is_absolute()
                || assets.directory.as_os_str().len() > 4096
                || assets.directory.components().any(|part| {
                    !matches!(
                        part,
                        std::path::Component::RootDir | std::path::Component::Normal(_)
                    )
                })
                || assets.manifest_sha256.len() != 64
                || !assets
                    .manifest_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(ConfigError(
                "editor assets require an absolute normalized directory and lowercase SHA-256",
            ));
        }
        if self.media_worker_socket.as_ref().is_some_and(|path| {
            !path.is_absolute()
                || path.as_os_str().len() > 100
                || path
                    .components()
                    .any(|p| matches!(p, std::path::Component::ParentDir))
        }) {
            return Err(ConfigError(
                "media worker requires an absolute private Unix socket path",
            ));
        }
        let origin = Url::parse(&self.origin).map_err(|_| ConfigError("invalid origin"))?;
        if origin.origin().ascii_serialization() != self.origin
            || !matches!(origin.scheme(), "http" | "https")
            || (self.secure_cookies && origin.scheme() != "https")
        {
            return Err(ConfigError(
                "origin must be exact; production requires HTTPS",
            ));
        }
        if !self.secure_cookies
            && !matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        {
            return Err(ConfigError("HTTP development origin must be loopback"));
        }
        let database =
            Url::parse(&self.database_url).map_err(|_| ConfigError("invalid database URL"))?;
        if !matches!(database.scheme(), "postgres" | "postgresql") || database.password().is_none()
        {
            return Err(ConfigError("PostgreSQL URL with credentials required"));
        }
        if !(SETUP_TOKEN_MIN_CHARS..=SETUP_TOKEN_MAX_CHARS)
            .contains(&self.setup_token.chars().count())
        {
            return Err(ConfigError(
                "HYORI_SETUP_TOKEN length is outside the setup API contract",
            ));
        }
        if self.auth_secret.len() < 32 {
            return Err(ConfigError(
                "HYORI_AUTH_SECRET must contain at least 32 bytes",
            ));
        }
        for secret in [&self.setup_token, &self.auth_secret] {
            if secret.to_ascii_lowercase().contains("replace")
                || secret.to_ascii_lowercase().contains("change-me")
            {
                return Err(ConfigError(
                    "operator secrets must be strong non-placeholder values",
                ));
            }
        }
        if self.setup_token == self.auth_secret || self.default_quota_bytes > 9_007_199_254_740_991
        {
            return Err(ConfigError(
                "independent secrets and safe integer quota required",
            ));
        }
        if !(1..=3650).contains(&self.trash_retention_days) {
            return Err(ConfigError("trash retention must be 1 to 3650 days"));
        }
        // Maintenance alone runs up to five concurrent loops; fewer would starve foreground work.
        if !(8..=1024).contains(&self.database_max_connections) {
            return Err(ConfigError(
                "database pool size must be 8 to 1024 connections",
            ));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_ranges_match_their_members_only() {
        let range: ProxyRange = "172.16.0.0/12".parse().unwrap();
        assert!(range.contains("172.31.255.255".parse().unwrap()));
        assert!(range.contains("::ffff:172.16.0.1".parse().unwrap()));
        assert!(!range.contains("172.32.0.0".parse().unwrap()));
        let host: ProxyRange = "fd00::7".parse().unwrap();
        assert!(host.contains("fd00::7".parse().unwrap()));
        assert!(!host.contains("fd00::8".parse().unwrap()));
    }
    #[test]
    fn ambiguous_proxy_ranges_are_refused() {
        for entry in [
            "10.0.0.1/8",
            "0.0.0.0/0",
            "::/0",
            "10.0.0.0/33",
            "10.0.0.0/",
            "10.0.0.0/+8",
            "::ffff:10.0.0.1",
            "proxy.internal",
        ] {
            assert!(entry.parse::<ProxyRange>().is_err(), "{entry}");
        }
    }
}

use crate::features::auth::api::{SETUP_TOKEN_MAX_CHARS, SETUP_TOKEN_MIN_CHARS};
use std::{net::SocketAddr, time::Duration};
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
    /// None is an explicit metadata-only fixture; storage operations return unavailable.
    pub storage: Option<hyori_storage::StorageConfig>,
    /// Operator-owned private Unix capability; absence disables derivative processing, not originals.
    pub media_worker_socket: Option<std::path::PathBuf>,
    /// Explicit operator-selected, pinned read-only editor bundle; absence disables runtime editing.
    pub editor_assets: Option<EditorAssetsConfig>,
}
#[derive(Debug, thiserror::Error)]
#[error("Invalid server configuration: {0}")]
pub struct ConfigError(&'static str);
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
            media_worker_socket: std::env::var_os("HYORI_MEDIA_WORKER_SOCKET").map(Into::into),
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
        Ok(())
    }
}

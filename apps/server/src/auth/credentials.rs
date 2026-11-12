use super::{AuthAdapter, map_auth_error, validate_password_length};
use crate::{error::ApiError, features::auth::api::NEW_PASSWORD_MIN_CHARS};
use better_auth::PasswordHasher;

impl AuthAdapter {
    pub async fn hash_account_password(&self, password: &str) -> Result<String, ApiError> {
        validate_password_length(password, NEW_PASSWORD_MIN_CHARS)?;
        self.hasher.hash(password).await.map_err(map_auth_error)
    }

    pub async fn verify_account_password(
        &self,
        hash: &str,
        password: &str,
    ) -> Result<bool, ApiError> {
        validate_password_length(password, 1)?;
        self.hasher
            .verify(hash, password)
            .await
            .map_err(map_auth_error)
    }
}

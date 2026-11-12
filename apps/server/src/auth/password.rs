use async_trait::async_trait;
use better_auth::{AuthError, AuthResult, PasswordHasher, ScryptPasswordHasher};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) struct BoundedHasher {
    active: Arc<Semaphore>,
    admitted: Arc<Semaphore>,
}
impl BoundedHasher {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Semaphore::new(2)),
            admitted: Arc::new(Semaphore::new(34)),
        }
    }
    fn admit(&self) -> AuthResult<OwnedSemaphorePermit> {
        self.admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| limited())
    }
}
fn limited() -> AuthError {
    AuthError::from_code("TOO_MANY_REQUESTS", "KDF_BUSY", "Password service busy")
}
#[async_trait]
impl PasswordHasher for BoundedHasher {
    async fn hash(&self, password: &str) -> AuthResult<String> {
        let admitted = self.admit()?;
        let active = self.active.clone();
        let password = password.to_owned();
        // Detached task retains permits until the library's blocking KDF actually finishes,
        // even when a disconnected HTTP request drops its awaiting future.
        tokio::spawn(async move {
            let _admitted = admitted;
            let _active =
                tokio::time::timeout(std::time::Duration::from_secs(10), active.acquire_owned())
                    .await
                    .map_err(|_| limited())?
                    .map_err(|_| limited())?;
            ScryptPasswordHasher.hash(&password).await
        })
        .await
        .map_err(|_| AuthError::internal("Password worker unavailable"))?
    }
    async fn verify(&self, hash: &str, password: &str) -> AuthResult<bool> {
        let admitted = self.admit()?;
        let active = self.active.clone();
        let hash = hash.to_owned();
        let password = password.to_owned();
        tokio::spawn(async move {
            let _admitted = admitted;
            let _active =
                tokio::time::timeout(std::time::Duration::from_secs(10), active.acquire_owned())
                    .await
                    .map_err(|_| limited())?
                    .map_err(|_| limited())?;
            ScryptPasswordHasher.verify(&hash, &password).await
        })
        .await
        .map_err(|_| AuthError::internal("Password worker unavailable"))?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_admission() {
        let hasher = BoundedHasher::new();
        let permits: Vec<_> = (0..34).map(|_| hasher.admit().unwrap()).collect();
        assert!(hasher.admit().is_err());
        drop(permits);
        assert!(hasher.admit().is_ok());
        assert_eq!(hasher.active.available_permits(), 2);
    }
}

use async_trait::async_trait;
use better_auth::{AuthError, AuthResult, PasswordHasher, ScryptPasswordHasher};
use std::sync::Arc;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::Instant,
};

/// Sign-in verifications computing at once, in their own lane.
pub const SIGN_IN_RUNNING: usize = 2;
/// Sign-in verifications that may wait for the lane; beyond them a sign-in is answered as busy.
pub const SIGN_IN_WAITING: usize = 4;

/// Sign-in verification has its own scrypt computations, so hashing for link passwords, new
/// accounts and password changes ([`BoundedHasher`]) never queues ahead of a sign-in.
pub(super) struct SignInLane {
    running: Arc<Semaphore>,
    admitted: Arc<Semaphore>,
}
impl SignInLane {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Semaphore::new(SIGN_IN_RUNNING)),
            admitted: Arc::new(Semaphore::new(SIGN_IN_RUNNING + SIGN_IN_WAITING)),
        }
    }
    /// A place in the lane, or None when every place is taken. Every sign-in takes one at the
    /// same point, whether or not its email has an account, so a busy answer depends on the
    /// lane only; one for an email without an account is dropped at once.
    pub fn admit(&self) -> Option<SignInPlace> {
        self.admitted
            .clone()
            .try_acquire_owned()
            .ok()
            .map(|admitted| SignInPlace {
                admitted,
                running: self.running.clone(),
            })
    }
}
pub(super) struct SignInPlace {
    admitted: OwnedSemaphorePermit,
    running: Arc<Semaphore>,
}
impl SignInPlace {
    /// Whether `password` matches `hash`, if known by `deadline`. A computation that started
    /// keeps its place until it finishes, even after the deadline or a dropped request, so the
    /// lane bounds real CPU and memory use.
    pub async fn verify(self, hash: String, password: String, deadline: Instant) -> Option<bool> {
        let Self { admitted, running } = self;
        let work = tokio::spawn(async move {
            let _admitted = admitted;
            let _running = tokio::time::timeout_at(deadline, running.acquire_owned())
                .await
                .ok()?
                .ok()?;
            // A malformed stored hash is a failed sign-in, like a wrong password.
            Some(
                ScryptPasswordHasher
                    .verify(&hash, &password)
                    .await
                    .unwrap_or(false),
            )
        });
        tokio::time::timeout_at(deadline, work).await.ok()?.ok()?
    }
}

/// Every other password hash and verification: link passwords, new accounts, password changes.
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
    #[tokio::test]
    async fn sign_in_lane_answers_by_the_deadline_and_keeps_places_until_work_ends() {
        let hash = ScryptPasswordHasher.hash("correct password").await.unwrap();
        let lane = SignInLane::new();
        let later = Instant::now() + std::time::Duration::from_secs(30);
        let verify = |password: &str, deadline| {
            lane.admit()
                .unwrap()
                .verify(hash.clone(), password.into(), deadline)
        };
        assert_eq!(verify("correct password", later).await, Some(true));
        assert_eq!(verify("wrong password", later).await, Some(false));
        // Unfinished by the deadline: no answer, and the computation still holds its place.
        let soon = Instant::now() + std::time::Duration::from_millis(1);
        assert_eq!(verify("correct password", soon).await, None);
        assert_eq!(
            lane.admitted.available_permits(),
            SIGN_IN_RUNNING + SIGN_IN_WAITING - 1
        );
        let places: Vec<_> = std::iter::from_fn(|| lane.admit()).collect();
        assert_eq!(places.len(), SIGN_IN_RUNNING + SIGN_IN_WAITING - 1);
    }
}

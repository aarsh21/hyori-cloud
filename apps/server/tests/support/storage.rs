use hyori_server::auth::random_token;
use hyori_storage::{ObjectStorage, StorageConfig};
use std::process::Command;

pub struct RustFs {
    pub config: StorageConfig,
    name: String,
}
fn docker(args: &[&str]) -> String {
    let output = Command::new("docker").args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
impl RustFs {
    pub async fn start() -> Self {
        let name = format!("hyori-upload-test-{}", &random_token()[..16]);
        let mut fixture = Self {
            name,
            config: StorageConfig {
                endpoint: String::new(),
                region: "us-east-1".into(),
                bucket: format!("test-{}", &random_token()[..16]),
                access_key_id: random_token(),
                secret_access_key: random_token(),
            },
        };
        // tmpfs is unique to this disposable container; no deployment volume is mounted.
        docker(&[
            "run",
            "--detach",
            "--name",
            &fixture.name,
            "-p",
            "127.0.0.1::9000",
            "--tmpfs",
            "/data:uid=10001,gid=10001",
            "--tmpfs",
            "/logs:uid=10001,gid=10001",
            "-e",
            &format!("RUSTFS_ACCESS_KEY={}", fixture.config.access_key_id),
            "-e",
            &format!("RUSTFS_SECRET_KEY={}", fixture.config.secret_access_key),
            "-e",
            "RUSTFS_CONSOLE_ENABLE=false",
            "rustfs/rustfs:1.0.0-alpha.85",
            "/data",
        ]);
        fixture.config.endpoint =
            format!("http://{}", docker(&["port", &fixture.name, "9000/tcp"]));
        let storage = ObjectStorage::new(fixture.config.clone()).unwrap();
        for _ in 0..300 {
            if storage.ensure_bucket().await.is_ok() {
                return fixture;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        panic!("isolated RustFS did not become ready");
    }
}
impl Drop for RustFs {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.name])
            .output();
    }
}

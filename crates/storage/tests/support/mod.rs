use std::process::{Command, Output};
use std::time::{Duration, Instant};

use hyori_storage::{ObjectStorage, StorageConfig};
use uuid::Uuid;

const IMAGE: &str = "rustfs/rustfs:1.0.0-alpha.85";

/// Only resources created by this fixture are ever removed, including during unwinding.
pub struct RustFs {
    pub config: StorageConfig,
    name: String,
    volumes: Vec<String>,
}

fn docker(args: &[&str]) -> Output {
    Command::new("docker")
        .args(args)
        .output()
        .expect("Docker must be available for the explicitly requested integration suite")
}

fn checked(args: &[&str]) -> String {
    let result = docker(args);
    assert!(
        result.status.success(),
        "Docker failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

impl RustFs {
    pub async fn start() -> Self {
        let suffix = Uuid::new_v4().simple().to_string();
        let mut service = Self {
            config: StorageConfig {
                endpoint: "http://127.0.0.1:1".into(),
                region: "us-east-1".into(),
                bucket: format!("hyori-storage-{suffix}"),
                access_key_id: Uuid::new_v4().simple().to_string(),
                secret_access_key: format!(
                    "{}{}",
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple()
                ),
            },
            name: format!("hyori-storage-test-{suffix}"),
            volumes: Vec::new(),
        };
        for kind in ["data", "logs"] {
            let volume = format!("{}-{kind}", service.name);
            checked(&["volume", "create", &volume]);
            service.volumes.push(volume);
        }
        let data = format!("{}:/storage", service.volumes[0]);
        let logs = format!("{}:/logs", service.volumes[1]);
        checked(&[
            "run",
            "--rm",
            "--volume",
            &data,
            "--volume",
            &logs,
            "alpine:3.22",
            "sh",
            "-c",
            "chown 10001:10001 /storage /logs",
        ]);
        let data = format!(
            "type=volume,src={},dst=/data,volume-nocopy",
            service.volumes[0]
        );
        let logs = format!(
            "type=volume,src={},dst=/logs,volume-nocopy",
            service.volumes[1]
        );
        checked(&[
            "run",
            "--detach",
            "--name",
            &service.name,
            "--publish",
            "127.0.0.1::9000",
            "--mount",
            &data,
            "--mount",
            &logs,
            "--env",
            &format!("RUSTFS_ACCESS_KEY={}", service.config.access_key_id),
            "--env",
            &format!("RUSTFS_SECRET_KEY={}", service.config.secret_access_key),
            "--env",
            "RUSTFS_CONSOLE_ENABLE=false",
            IMAGE,
            "/data",
        ]);
        let published = checked(&["port", &service.name, "9000/tcp"]);
        assert!(
            published.starts_with("127.0.0.1:"),
            "Test endpoint must be loopback-only"
        );
        assert!(!published.contains('\n'));
        service.config.endpoint = format!("http://{published}");
        let client = ObjectStorage::new(service.config.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            match client.ensure_bucket().await {
                Ok(()) => break,
                Err(error) if Instant::now() >= deadline => {
                    panic!("RustFS readiness failed: {error}")
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
        service
    }

    pub fn client(&self) -> ObjectStorage {
        ObjectStorage::new(self.config.clone()).unwrap()
    }

    pub fn stop(&self) {
        checked(&["stop", "--time", "1", &self.name]);
    }

    pub fn restart(&mut self) {
        checked(&["restart", "--time", "1", &self.name]);
        // Docker can assign a new ephemeral published port when restarting the container.
        let published = checked(&["port", &self.name, "9000/tcp"]);
        assert!(published.starts_with("127.0.0.1:") && !published.contains('\n'));
        self.config.endpoint = format!("http://{published}");
    }
}

impl Drop for RustFs {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let logs = docker(&["logs", "--tail", "50", &self.name]);
            eprintln!(
                "Isolated RustFS failure logs:\n{}\n{}",
                String::from_utf8_lossy(&logs.stdout),
                String::from_utf8_lossy(&logs.stderr)
            );
        }
        let _ = docker(&["rm", "--force", &self.name]);
        for volume in &self.volumes {
            let _ = docker(&["volume", "rm", volume]);
        }
    }
}

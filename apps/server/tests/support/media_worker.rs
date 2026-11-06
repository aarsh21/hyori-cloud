use hyori_server::auth::random_token;
use std::{os::unix::fs::DirBuilderExt, path::PathBuf, process::Command};
pub struct Worker {
    pub socket: PathBuf,
    pub name: String,
    directory: PathBuf,
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
impl Worker {
    pub async fn start() -> Self {
        let suffix = &random_token()[..16];
        let directory = std::env::temp_dir().join(format!("hyori-media-{suffix}"));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let fixture = Self {
            socket: directory.join("worker.sock"),
            name: format!("hyori-media-{suffix}"),
            directory,
        };
        let uid = String::from_utf8(Command::new("id").arg("-u").output().unwrap().stdout).unwrap();
        let gid = String::from_utf8(Command::new("id").arg("-g").output().unwrap().stdout).unwrap();
        let image = std::env::var("HYORI_MEDIA_TEST_IMAGE")
            .expect("build apps/media-worker/Dockerfile and set HYORI_MEDIA_TEST_IMAGE");
        docker(&[
            "run",
            "--init",
            "--detach",
            "--name",
            &fixture.name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            &format!("{}:{}", uid.trim(), gid.trim()),
            "--cpus",
            "1",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--pids-limit",
            "64",
            "--tmpfs",
            &format!(
                "/scratch:rw,noexec,nosuid,size=96m,uid={},gid={},mode=0700",
                uid.trim(),
                gid.trim()
            ),
            "--mount",
            &format!(
                "type=bind,source={},target=/run/hyori-media",
                fixture.directory.display()
            ),
            &image,
        ]);
        for _ in 0..100 {
            if fixture.socket.exists() {
                return fixture;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!(
            "worker failed startup: {}",
            docker(&["logs", &fixture.name])
        );
    }
    pub fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .unix_socket(self.socket.as_path())
            .no_proxy()
            .build()
            .unwrap()
    }
    pub fn stop(&self) {
        docker(&["stop", "--time", "2", &self.name]);
    }
    pub async fn restart(&self) {
        docker(&["start", &self.name]);
        for _ in 0..100 {
            if std::os::unix::net::UnixStream::connect(&self.socket).is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("worker did not restart");
    }
    pub fn pause(&self) {
        docker(&["pause", &self.name]);
    }
    pub fn resume(&self) {
        docker(&["unpause", &self.name]);
    }
    pub fn inspect(&self) -> serde_json::Value {
        serde_json::from_str(&docker(&["inspect", &self.name])).unwrap()
    }
    pub fn scratch_count(&self) -> String {
        docker(&[
            "exec",
            &self.name,
            "find",
            "/scratch",
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
        ])
    }
    pub fn decode_output(&self, bytes: &[u8]) {
        let path = self.directory.join("verified.png");
        std::fs::write(&path, bytes).unwrap();
        docker(&[
            "exec",
            &self.name,
            "/usr/bin/ffmpeg",
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            "/run/hyori-media/verified.png",
            "-f",
            "null",
            "-",
        ]);
        std::fs::remove_file(path).unwrap();
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", &self.name])
            .output();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

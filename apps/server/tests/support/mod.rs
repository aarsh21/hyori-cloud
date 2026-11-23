use hyori_server::{AppState, auth::random_token, config::Config, router};
use serde_json::{Value, json};
use std::{process::Command, sync::Arc};

pub struct Postgres {
    name: String,
    pub config: Config,
}
impl Postgres {
    pub async fn start() -> Self {
        let name = format!("hyori-rust-auth-test-{}", &random_token()[..16]);
        let password = random_token();
        let output = Command::new("docker")
            .args([
                "run",
                "--detach",
                "--rm",
                "--name",
                &name,
                "-p",
                "127.0.0.1::5432",
                "-e",
                "POSTGRES_PASSWORD",
                "-e",
                "POSTGRES_USER=hyori_test",
                "-e",
                "POSTGRES_DB=hyori_test",
                "postgres:17",
            ])
            .env("POSTGRES_PASSWORD", &password)
            .output()
            .expect("Docker required");
        assert!(
            output.status.success(),
            "test PostgreSQL startup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut fixture = Self {
            name,
            config: Config {
                database_url: String::new(),
                origin: "http://localhost:3001".into(),
                setup_token: random_token(),
                auth_secret: random_token(),
                secure_cookies: false,
                bind: "127.0.0.1:0".parse().unwrap(),
                default_quota_bytes: 10 * 1024 * 1024 * 1024,
                trash_retention_days: hyori_server::config::DEFAULT_TRASH_RETENTION_DAYS,
                database_max_connections: hyori_server::config::DEFAULT_DATABASE_CONNECTIONS,
                storage: None,
                media_worker_socket: None,
                editor_assets: None,
                retained_editor_assets: None,
                trusted_proxies: vec![],
                // Well above one verification here (scrypt is optimized in test builds), and
                // short enough that suites full of failed sign-ins stay quick.
                sign_in_answer: std::time::Duration::from_secs(1),
            },
        };
        let output = Command::new("docker")
            .args(["port", &fixture.name, "5432/tcp"])
            .output()
            .unwrap();
        let address = String::from_utf8(output.stdout).unwrap();
        let address = address.trim();
        assert!(address.starts_with("127.0.0.1:"));
        fixture.config.database_url =
            format!("postgres://hyori_test:{password}@{address}/hyori_test");
        for _ in 0..100 {
            if Command::new("docker")
                .args([
                    "exec",
                    &fixture.name,
                    "pg_isready",
                    "-h",
                    "127.0.0.1",
                    "-U",
                    "hyori_test",
                    "-d",
                    "hyori_test",
                ])
                .output()
                .unwrap()
                .status
                .success()
            {
                return fixture;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("test PostgreSQL did not become ready");
    }
    pub fn stop(&self) {
        assert!(
            Command::new("docker")
                .args(["stop", &self.name])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
}
impl Drop for Postgres {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "--force", "--volumes", &self.name])
            .output();
    }
}
pub struct TestServer {
    pub state: Arc<AppState>,
    pub client: reqwest::Client,
    pub url: String,
    handle: tokio::task::JoinHandle<()>,
}
impl TestServer {
    pub async fn start(config: Config) -> Self {
        let state = AppState::connect(config).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = router(state.clone());
        // As in production, so limits see the TCP peer (loopback here, an unlisted proxy).
        let handle = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            state,
            client: reqwest::Client::new(),
            url,
            handle,
        }
    }
    pub async fn rpc(&self, operation: &str, input: Value, cookie: Option<&str>) -> Reply {
        self.rpc_from(None, operation, input, cookie).await
    }
    /// An RPC carrying the client-address header a proxy would add, when `client` is given.
    pub async fn rpc_from(
        &self,
        client: Option<&str>,
        operation: &str,
        input: Value,
        cookie: Option<&str>,
    ) -> Reply {
        let mut request = self
            .client
            .post(format!("{}/api/rpc", self.url))
            .header("origin", &self.state.config.origin)
            .header("host", "localhost:3001")
            .json(&json!({"operation": operation, "input": input}));
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(client) = client {
            request = request.header(hyori_server::rpc::CLIENT_ADDRESS_HEADER, client);
        }
        let response = request.send().await.unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let status = response.status().as_u16();
        let cookies: Vec<_> = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .map(|header| header.to_str().unwrap().to_owned())
            .collect();
        let cookie = cookies.first().cloned();
        let body = response.json::<Value>().await.unwrap();
        Reply {
            status,
            body,
            cookie,
            cookies,
        }
    }
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub cookie: Option<String>,
    pub cookies: Vec<String>,
}
impl Reply {
    pub fn value(&self) -> &Value {
        assert_eq!(self.status, 200, "{}", self.body);
        assert_eq!(self.body["ok"], true);
        &self.body["value"]
    }
    pub fn error(&self, status: u16, code: &str) {
        assert_eq!(self.status, status, "{}", self.body);
        assert_eq!(self.body["ok"], false);
        assert_eq!(self.body["error"]["code"], code);
    }
    pub fn credential(&self) -> String {
        assert!(!self.cookies.is_empty());
        self.cookies
            .iter()
            .filter(|cookie| !cookie.contains("Max-Age=0"))
            .map(|cookie| cookie.split(';').next().unwrap())
            .collect::<Vec<_>>()
            .join("; ")
    }
}

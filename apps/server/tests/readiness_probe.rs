use axum::{Router, http::StatusCode, routing::get};
use std::process::Stdio;
use tokio::{net::TcpListener, process::Command};

#[tokio::test]
async fn health_command_checks_ready_without_initializing_the_application() {
    for status in [
        StatusCode::OK,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::FOUND,
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/health/ready", get(move || async move { status })),
            )
            .await
            .unwrap();
        });
        // No DB/storage credentials; wildcard bind must be probed through loopback.
        let result = Command::new(env!("CARGO_BIN_EXE_hyori-server"))
            .arg("--health")
            .env_clear()
            .env("HYORI_SERVER_BIND", format!("0.0.0.0:{port}"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .unwrap();
        server.abort();
        assert_eq!(result.success(), status == StatusCode::OK, "{status}");
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let result = Command::new(env!("CARGO_BIN_EXE_hyori-server"))
        .arg("--health")
        .env_clear()
        .env("HYORI_SERVER_BIND", address.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(!result.success(), "a closed listener is not ready");
}

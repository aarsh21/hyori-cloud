use hyori_server::{AppState, config::Config, router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if std::env::args().nth(1).as_deref() == Some("--health") {
        return health().await;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hyori_server=info".into()),
        )
        .try_init()?;
    let config = Config::from_env()?;
    let bind = config.bind;
    let state = AppState::connect(config).await?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "Rust backend listening");
    let signal = shutdown()?;
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let maintenance = tokio::spawn(hyori_server::maintenance::run(state.clone(), stopped));
    let served = axum::serve(
        listener,
        router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(signal)
    .await;
    let _ = stop.send(true);
    let maintained = maintenance.await;
    let drained = state.drain_transfers().await;
    let closed = state.db.clone().close().await;
    served?;
    drained?;
    maintained?;
    closed?;
    Ok(())
}

async fn health() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut bind: std::net::SocketAddr = std::env::var("HYORI_SERVER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3002".into())
        .parse()?;
    if bind.ip().is_unspecified() {
        bind.set_ip(match bind.ip() {
            std::net::IpAddr::V4(_) => std::net::Ipv4Addr::LOCALHOST.into(),
            std::net::IpAddr::V6(_) => std::net::Ipv6Addr::LOCALHOST.into(),
        });
    }
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()?
        .get(format!("http://{bind}/health/ready"))
        .send()
        .await?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("backend not ready: HTTP {}", response.status()).into());
    }
    Ok(())
}

fn shutdown() -> std::io::Result<impl std::future::Future<Output = ()>> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        Ok(async move {
            tokio::select! {
                result = tokio::signal::ctrl_c() => {
                    if let Err(error) = result {
                        tracing::error!(%error, "interrupt handler failed; shutting down");
                    }
                },
                _ = terminate.recv() => {},
            }
        })
    }
    #[cfg(not(unix))]
    {
        Ok(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                tracing::error!(%error, "interrupt handler failed; shutting down");
            }
        })
    }
}

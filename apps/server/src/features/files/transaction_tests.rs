use crate::support::Postgres;
use hyori_server::db::{self, sql};
use sea_orm::{ConnectionTrait, IsolationLevel, TransactionTrait};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

// Forward the first session unchanged, except for withholding PostgreSQL's CommandComplete
// for BEGIN. The server has opened the transaction but the driver cannot yet know it succeeded.
async fn gate_begin_reply(
    listener: TcpListener,
    upstream_port: u16,
    reached: oneshot::Sender<()>,
    resume: oneshot::Receiver<()>,
) -> std::io::Result<()> {
    let (client, _) = listener.accept().await?;
    let server = TcpStream::connect(("127.0.0.1", upstream_port)).await?;
    let (mut client_in, mut client_out) = client.into_split();
    let (mut server_in, mut server_out) = server.into_split();
    tokio::select! {
        result = copy(&mut client_in, &mut server_out) => result?,
        result = async {
            let mut gate = Some((reached, resume));
            while gate.is_some() {
                let tag = server_in.read_u8().await?;
                let len = server_in.read_u32().await?;
                let mut payload = vec![0; (len - 4) as usize];
                server_in.read_exact(&mut payload).await?;
                if tag == b'C' && payload == b"BEGIN\0" {
                    let (reached, resume) = gate.take().unwrap();
                    reached.send(()).unwrap();
                    resume.await.unwrap();
                }
                client_out.write_u8(tag).await?;
                client_out.write_u32(len).await?;
                client_out.write_all(&payload).await?;
            }
            copy(&mut server_in, &mut client_out).await
        } => result?,
    };
    Ok(())
}

#[tokio::test]
#[ignore = "real PostgreSQL BEGIN cancellation; unique loopback container"]
async fn cancelling_begin_does_not_lend_an_open_transaction_to_the_next_borrower() {
    let mut pg = Postgres::start().await;
    let observer = db::connect(&pg.config).await.unwrap();
    observer
        .execute_unprepared("CREATE TABLE fixture_writes (value int)")
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut url = url::Url::parse(&pg.config.database_url).unwrap();
    let upstream_port = url.port().unwrap();
    url.set_port(Some(listener.local_addr().unwrap().port()))
        .unwrap();
    url.set_query(Some("sslmode=disable")); // inspect only this fixture's plaintext protocol
    pg.config.database_url = url.to_string();
    pg.config.database_max_connections = 1;
    let (reached, at_begin) = oneshot::channel();
    let (resume, paused) = oneshot::channel();
    let relay = tokio::spawn(gate_begin_reply(listener, upstream_port, reached, paused));
    let pool = db::connect(&pg.config).await.unwrap();

    let callback_ran = AtomicBool::new(false);
    let mut opening = Box::pin(db::domain(&pool, |_| {
        callback_ran.store(true, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }));
    tokio::select! {
        result = &mut opening => panic!("BEGIN was not held: {result:?}"),
        result = tokio::time::timeout(std::time::Duration::from_secs(5), at_begin) => result.unwrap().unwrap(),
    }
    drop(opening);
    resume.send(()).unwrap();

    pool.execute_unprepared("INSERT INTO fixture_writes VALUES (1)")
        .await
        .unwrap();
    let visible = observer
        .query_one_raw(sql("SELECT count(*) AS n FROM fixture_writes", vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "n")
        .unwrap();
    // Use the driver directly here so a dirty session reports the original SQLSTATE.
    let next = pool
        .begin_with_config(Some(IsolationLevel::Serializable), None)
        .await;
    assert!(
        visible == 1 && next.is_ok(),
        "autocommit rows visible to another session: {visible}; next SERIALIZABLE begin: {next:?}"
    );
    assert!(!callback_ran.load(Ordering::SeqCst));
    next.unwrap().rollback().await.unwrap();
    pool.close().await.unwrap();
    relay.await.unwrap().unwrap();
    observer.close().await.unwrap();
}

#[tokio::test]
#[ignore = "real PostgreSQL serialization conflicts; unique loopback container"]
async fn serializable_callbacks_retry_without_lost_updates_and_stop_after_four_attempts() {
    let pg = Postgres::start().await;
    let connection = db::connect(&pg.config).await.unwrap();
    connection.execute_unprepared("CREATE TABLE fixture_counter (id integer PRIMARY KEY, value integer NOT NULL); INSERT INTO fixture_counter VALUES (1,0)").await.unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));
    let increment = || {
        let barrier = barrier.clone();
        let calls = calls.clone();
        db::domain(&connection, move |tx| {
            let barrier = barrier.clone();
            let calls = calls.clone();
            Box::pin(async move {
                let value = tx
                    .query_one_raw(sql("SELECT value FROM fixture_counter WHERE id=1", vec![]))
                    .await?
                    .unwrap()
                    .try_get::<i32>("", "value")?;
                // Test-only barrier forces both first attempts to read the same snapshot value.
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    barrier.wait().await;
                }
                tx.execute_raw(sql(
                    "UPDATE fixture_counter SET value=$1 WHERE id=1",
                    vec![(value + 1).into()],
                ))
                .await?;
                Ok(value + 1)
            })
        })
    };
    let (first, second) = tokio::join!(increment(), increment());
    let mut values = [first.unwrap(), second.unwrap()];
    values.sort();
    assert_eq!(values, [1, 2]);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempt_count = attempts.clone();
    let result: Result<(), _> = db::domain(&connection, move |tx| {
        let attempts = attempts.clone();
        Box::pin(async move {
            attempts.fetch_add(1, Ordering::SeqCst);
            tx.execute_unprepared(
                "DO $$ BEGIN RAISE EXCEPTION 'retry fixture' USING ERRCODE='40001'; END $$",
            )
            .await?;
            Ok(())
        })
    })
    .await;
    assert_eq!(
        result.unwrap_err().code,
        hyori_server::error::ErrorCode::Unavailable
    );
    assert_eq!(attempt_count.load(Ordering::SeqCst), 4);
    connection.close().await.unwrap();
}

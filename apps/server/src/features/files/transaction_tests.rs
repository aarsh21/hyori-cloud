use crate::support::Postgres;
use hyori_server::db::{self, sql};
use sea_orm::ConnectionTrait;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

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

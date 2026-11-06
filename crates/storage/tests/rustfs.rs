//! Explicit real-service gate: cargo test -p hyori-storage --test rustfs -- --ignored --nocapture
//! Each test owns a unique loopback-only container, bucket, credentials and disposable volumes.
mod support;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::{StreamExt, stream};
use hyori_storage::{Bytes, CHUNK_SIZE, ObjectStorage, PartRef, StorageError, StorageStream};
use support::RustFs;

fn bytes(value: &'static [u8]) -> StorageStream {
    Box::pin(stream::iter([Ok(Bytes::from_static(value))]))
}

fn patterned(length: u64, value: u8) -> StorageStream {
    Box::pin(stream::unfold(length, move |remaining| async move {
        if remaining == 0 {
            None
        } else {
            let count = remaining.min(64 * 1024);
            Some((
                Ok(Bytes::from(vec![value; count as usize])),
                remaining - count,
            ))
        }
    }))
}

async fn small_bytes(mut source: StorageStream) -> Vec<u8> {
    let mut result = Vec::new();
    while let Some(chunk) = source.next().await {
        result.extend_from_slice(&chunk.unwrap());
        assert!(
            result.len() < 1024,
            "Only small fixture ranges should be collected"
        );
    }
    result
}

#[tokio::test]
#[ignore = "starts an isolated pinned Docker RustFS service"]
async fn durable_multipart_replacement_sorted_completion_restart_replay_and_download_ranges() {
    let mut service = RustFs::start().await;
    let storage = service.client();
    storage.ensure_bucket().await.unwrap();
    let key = "owners/lifecycle/unique-object";
    let upload = storage
        .begin(key, "application/octet-stream")
        .await
        .unwrap();
    let stale = storage
        .part(key, &upload, 1, CHUNK_SIZE, patterned(CHUNK_SIZE, b'a'))
        .await
        .unwrap();
    let first = storage
        .part(key, &upload, 1, CHUNK_SIZE, patterned(CHUNK_SIZE, b'b'))
        .await
        .unwrap();
    assert_ne!(first, stale);
    drop(storage);

    // Reconstruct the client and restart the isolated persistent RustFS process mid-upload.
    service.restart();
    let storage = service.client();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while storage.ensure_bucket().await.is_err() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let second = storage
        .part(key, &upload, 2, 4, bytes(b"tail"))
        .await
        .unwrap();
    let bad = [
        PartRef {
            part_number: 1,
            etag: stale,
        },
        PartRef {
            part_number: 2,
            etag: second.clone(),
        },
    ];
    assert!(
        storage
            .complete(key, &upload, &bad, CHUNK_SIZE + 4)
            .await
            .is_err(),
        "Stale repeated-part ETag must not commit"
    );
    assert!(
        storage.head(key).await.is_err(),
        "Incomplete bytes must not appear as a committed object"
    );
    let parts = [
        PartRef {
            part_number: 2,
            etag: second,
        },
        PartRef {
            part_number: 1,
            etag: first,
        },
    ];
    let head = storage
        .complete(key, &upload, &parts, CHUNK_SIZE + 4)
        .await
        .unwrap();
    assert_eq!(head.size, CHUNK_SIZE + 4);
    assert_eq!(
        head.content_type.as_deref(),
        Some("application/octet-stream")
    );
    let reconstructed = service.client();
    assert_eq!(
        reconstructed
            .complete(key, &upload, &parts, CHUNK_SIZE + 4)
            .await
            .unwrap()
            .size,
        CHUNK_SIZE + 4
    );
    assert!(
        reconstructed
            .complete(key, &upload, &parts, CHUNK_SIZE + 5)
            .await
            .is_err()
    );
    assert!(
        reconstructed
            .unfinished(key)
            .await
            .unwrap()
            .uploads
            .is_empty()
    );

    let mut download = reconstructed.read(key, None).await.unwrap();
    assert_eq!(
        (
            download.status,
            download.size,
            download.content_range.as_deref()
        ),
        (200, CHUNK_SIZE + 4, None)
    );
    let mut position = 0;
    while let Some(chunk) = download.body.next().await {
        for byte in chunk.unwrap() {
            let expected = if position < CHUNK_SIZE {
                b'b'
            } else {
                b"tail"[(position - CHUNK_SIZE) as usize]
            };
            assert_eq!(byte, expected, "byte mismatch at {position}");
            position += 1;
        }
    }
    assert_eq!(position, CHUNK_SIZE + 4);
    for (range, expected, expected_range) in [
        (
            "bytes=0-2",
            b"bbb".as_slice(),
            format!("bytes 0-2/{}", CHUNK_SIZE + 4),
        ),
        (
            "bytes=-4",
            b"tail".as_slice(),
            format!("bytes {}-{}/{}", CHUNK_SIZE, CHUNK_SIZE + 3, CHUNK_SIZE + 4),
        ),
    ] {
        let download = reconstructed.read(key, Some(range)).await.unwrap();
        assert_eq!(download.status, 206);
        assert_eq!(download.size, expected.len() as u64);
        assert_eq!(
            download.content_range.as_deref(),
            Some(expected_range.as_str())
        );
        assert_eq!(small_bytes(download.body).await, expected);
    }
    let range = format!("bytes={CHUNK_SIZE}-");
    let download = reconstructed.read(key, Some(&range)).await.unwrap();
    assert_eq!(small_bytes(download.body).await, b"tail");
    assert!(matches!(
        reconstructed
            .read(key, Some("bytes=999999999-9999999999"))
            .await,
        Err(StorageError::Service {
            status: Some(416),
            ..
        })
    ));
    assert!(matches!(
        reconstructed.read(key, Some("bytes=0-1,3-4")).await,
        Err(StorageError::InvalidInput(_))
    ));
    reconstructed.remove(key).await.unwrap();
    reconstructed.remove(key).await.unwrap();
    assert!(reconstructed.head(key).await.is_err());
    eprintln!(
        "REAL RustFS: restart/resume, repeated part, stale ETag failure, sorted completion, replay, exact size, streamed bytes, 200/206 ranges, 416 and removal passed"
    );
}

#[tokio::test]
#[ignore = "starts an isolated pinned Docker RustFS service"]
async fn exact_key_cleanup_drains_bounded_first_pages_and_never_aborts_prefix_neighbours() {
    let service = RustFs::start().await;
    let storage = service.client();
    let key = "owners/cleanup/target";
    let neighbour = "owners/cleanup/target-neighbour";
    let retained = storage.begin(key, "text/plain").await.unwrap();
    for _ in 0..102 {
        storage.begin(key, "text/plain").await.unwrap();
    }
    let neighbour_id = storage.begin(neighbour, "text/plain").await.unwrap();
    let first = storage.unfinished(key).await.unwrap();
    assert_eq!(first.uploads.len(), 100);
    assert!(first.pending);
    let mut ids = first
        .uploads
        .iter()
        .map(|u| u.upload_id.as_str())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 100);

    let pass = storage
        .abort_unfinished(key, Some(&retained))
        .await
        .unwrap();
    assert!(pass.aborted <= 100 && pass.aborted >= 99);
    assert!(pass.pending);
    let pass2 = storage
        .abort_unfinished(key, Some(&retained))
        .await
        .unwrap();
    assert_eq!(pass.aborted + pass2.aborted, 102);
    assert_eq!(
        storage
            .unfinished(key)
            .await
            .unwrap()
            .uploads
            .iter()
            .map(|u| &u.upload_id)
            .collect::<Vec<_>>(),
        [&retained]
    );
    assert_eq!(
        storage.unfinished(neighbour).await.unwrap().uploads[0].upload_id,
        neighbour_id
    );
    storage
        .part(neighbour, &neighbour_id, 1, 1, bytes(b"x"))
        .await
        .unwrap();
    storage.abort(key, &retained).await.unwrap();
    storage.abort(key, &retained).await.unwrap();
    storage.abort(neighbour, &neighbour_id).await.unwrap();
    assert!(storage.unfinished(key).await.unwrap().uploads.is_empty());
    eprintln!(
        "REAL RustFS: 103 durable uploads drained in bounded first-page sweeps; exact-key cleanup and retained ID preserve prefix-neighbour session; repeated abort passed"
    );
}

#[tokio::test]
#[ignore = "starts an isolated pinned Docker RustFS service"]
async fn owner_purge_drains_bounded_pages_and_failures_do_not_become_success() {
    let service = RustFs::start().await;
    let storage = service.client();
    for index in 0..101 {
        let key = format!("owners/purge/object-{index:03}");
        let id = storage.begin(&key, "text/plain").await.unwrap();
        let etag = storage.part(&key, &id, 1, 1, bytes(b"x")).await.unwrap();
        storage
            .complete(
                &key,
                &id,
                &[PartRef {
                    part_number: 1,
                    etag,
                }],
                1,
            )
            .await
            .unwrap();
        storage
            .begin(&format!("owners/purge/pending-{index:03}"), "text/plain")
            .await
            .unwrap();
    }
    let neighbour = "owners/purge-neighbour/retained";
    let neighbour_id = storage.begin(neighbour, "text/plain").await.unwrap();
    let etag = storage
        .part(neighbour, &neighbour_id, 1, 1, bytes(b"y"))
        .await
        .unwrap();
    storage
        .complete(
            neighbour,
            &neighbour_id,
            &[PartRef {
                part_number: 1,
                etag,
            }],
            1,
        )
        .await
        .unwrap();
    let pending_neighbour = storage.begin(neighbour, "text/plain").await.unwrap();
    let first = storage.purge_owner_objects("purge").await.unwrap();
    assert_eq!((first.deleted, first.pending), (100, true));
    let second = storage.purge_owner_objects("purge").await.unwrap();
    assert_eq!((second.deleted, second.pending), (1, false));
    let empty = storage.purge_owner_objects("purge").await.unwrap();
    assert_eq!((empty.deleted, empty.pending), (0, false));
    // Objects-only completion MUST NOT imply multipart cleanup. The parent owns durable key intents.
    for index in 0..101 {
        let key = format!("owners/purge/pending-{index:03}");
        assert_eq!(
            storage.abort_unfinished(&key, None).await.unwrap().aborted,
            1
        );
    }
    assert_eq!(
        small_bytes(storage.read(neighbour, None).await.unwrap().body).await,
        b"y"
    );
    assert_eq!(
        storage.unfinished(neighbour).await.unwrap().uploads[0].upload_id,
        pending_neighbour
    );
    for bad in [
        "",
        "../purge",
        "purge/",
        "purge-neighbour/../purge",
        "purge%2f",
        ".",
        "*",
    ] {
        assert!(matches!(
            storage.purge_owner_objects(bad).await,
            Err(StorageError::InvalidInput(_))
        ));
    }

    let mut denied = service.config.clone();
    denied.secret_access_key = "wrong-independent-test-secret".into();
    let denied = ObjectStorage::new(denied).unwrap();
    assert!(matches!(
        denied.ensure_bucket().await,
        Err(StorageError::Service {
            status: Some(403),
            ..
        })
    ));
    assert!(denied.purge_owner_objects("purge-neighbour").await.is_err());
    assert!(denied.remove(neighbour).await.is_err());
    assert!(denied.abort(neighbour, &pending_neighbour).await.is_err());
    assert!(denied.begin(neighbour, "text/plain").await.is_err());

    let mut missing = service.config.clone();
    missing.bucket.push_str("-missing");
    let missing = ObjectStorage::new(missing).unwrap();
    let error = missing
        .abort(neighbour, &pending_neighbour)
        .await
        .unwrap_err();
    assert!(
        matches!(error, StorageError::Service {code: Some(ref code), ..} if code == "NoSuchBucket"),
        "Expected missing bucket failure, received {error}"
    );
    service.stop();
    assert!(storage.ensure_bucket().await.is_err());
    assert!(storage.abort(neighbour, &pending_neighbour).await.is_err());
    assert!(
        storage
            .purge_owner_objects("purge-neighbour")
            .await
            .is_err()
    );
    assert!(storage.remove(neighbour).await.is_err());
    eprintln!(
        "REAL RustFS: objects-only owner purge 100+1 and per-intent exact-key multipart cleanup preserve neighbouring owner; traversal, credential/missing-bucket/outage failures passed"
    );
}

#[tokio::test]
#[ignore = "starts an isolated pinned Docker RustFS service"]
async fn zero_byte_file_and_exact_length_stream_failures_and_cancellation() {
    let service = RustFs::start().await;
    let storage = service.client();
    let key = "owners/empty/unique-object";
    let id = storage
        .begin(key, "application/octet-stream")
        .await
        .unwrap();
    let etag = storage
        .part(key, &id, 1, 0, Box::pin(stream::empty()))
        .await
        .unwrap();
    let parts = [PartRef {
        part_number: 1,
        etag,
    }];
    let head = storage.complete(key, &id, &parts, 0).await.unwrap();
    assert_eq!(head.size, 0);
    assert_eq!(storage.complete(key, &id, &parts, 0).await.unwrap().size, 0);
    let empty = storage.read(key, None).await.unwrap();
    assert_eq!((empty.status, empty.size), (200, 0));
    assert_eq!(small_bytes(empty.body).await, b"");

    let key = "owners/empty/invalid-part";
    let id = storage.begin(key, "text/plain").await.unwrap();
    assert!(matches!(
        storage.part(key, &id, 1, 0, bytes(b"x")).await,
        Err(StorageError::Body(_))
    ));
    assert!(storage.part(key, &id, 1, 2, bytes(b"x")).await.is_err());
    assert!(storage.part(key, &id, 1, 1, bytes(b"xx")).await.is_err());
    let too_long = Box::pin(stream::iter([
        Ok(Bytes::from_static(b"x")),
        Ok(Bytes::from_static(b"y")),
    ]));
    assert!(storage.part(key, &id, 1, 1, too_long).await.is_err());
    let polls = Arc::new(AtomicUsize::new(0));
    let count = polls.clone();
    let source = Box::pin(stream::poll_fn(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
        std::task::Poll::Ready(Some(Ok(Bytes::from_static(b"x"))))
    }));
    assert!(matches!(
        storage.part(key, &id, 0, 1, source).await,
        Err(StorageError::InvalidInput(_))
    ));
    assert_eq!(
        polls.load(Ordering::SeqCst),
        0,
        "Rejected admission must not consume source bytes"
    );
    assert!(matches!(
        storage.part(key, &id, 10_001, 1, bytes(b"x")).await,
        Err(StorageError::InvalidInput(_))
    ));
    assert!(matches!(
        storage.part(key, &id, 1, CHUNK_SIZE + 1, bytes(b"x")).await,
        Err(StorageError::InvalidInput(_))
    ));

    struct PendingSource(Arc<AtomicBool>);
    impl futures_core::Stream for PendingSource {
        type Item = hyori_storage::Result<Bytes>;
        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            std::task::Poll::Pending
        }
    }
    impl Drop for PendingSource {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let dropped = Arc::new(AtomicBool::new(false));
    let request = storage.part(key, &id, 1, 1, Box::pin(PendingSource(dropped.clone())));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), request)
            .await
            .is_err()
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !dropped.load(Ordering::Acquire) && tokio::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
    assert!(
        dropped.load(Ordering::Acquire),
        "Cancelling the request must release its producer"
    );
    storage.abort(key, &id).await.unwrap();
    eprintln!(
        "REAL RustFS: one real zero-byte multipart part completes/replays/downloads an empty file; exact length, admission without polling, and upload cancellation passed"
    );
}

#[tokio::test]
#[ignore = "characterizes a pinned RustFS incompatibility, not a successful prefix purge"]
async fn pinned_rustfs_multipart_prefix_listing_and_continuations_are_not_cleanup_capabilities() {
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};

    let service = RustFs::start().await;
    let storage = service.client();
    let key = "owners/compatibility/exact";
    for _ in 0..3 {
        storage.begin(key, "text/plain").await.unwrap();
    }
    let config = &service.config;
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .endpoint_url(&config.endpoint)
            .region(Region::new(config.region.clone()))
            .force_path_style(true)
            .credentials_provider(Credentials::new(
                &config.access_key_id,
                &config.secret_access_key,
                None,
                None,
                "explicit-test",
            ))
            .build(),
    );
    let owner = client
        .list_multipart_uploads()
        .bucket(&config.bucket)
        .prefix("owners/compatibility/")
        .max_uploads(100)
        .send()
        .await
        .unwrap();
    assert!(
        owner.uploads().is_empty(),
        "This records the alpha.85 exact-prefix bug; if fixed, revisit the owned compatibility boundary"
    );
    assert_eq!(owner.is_truncated, Some(false));
    let exact = client
        .list_multipart_uploads()
        .bucket(&config.bucket)
        .prefix(key)
        .max_uploads(1)
        .send()
        .await
        .unwrap();
    assert_eq!(exact.uploads().len(), 2, "alpha.85 returns max_uploads + 1");
    assert_eq!(exact.is_truncated, Some(true));
    assert!(
        exact.next_key_marker.is_none() && exact.next_upload_id_marker.is_none(),
        "alpha.85 drops multipart continuation markers"
    );
    assert_eq!(
        storage.abort_unfinished(key, None).await.unwrap().aborted,
        3
    );
    eprintln!(
        "KNOWN PINNED RUSTFS LIMIT: owner multipart prefix incorrectly reports clean and exact listing returns max+1 without continuation markers; no owned complete-prefix purge API is exposed"
    );
}

//! Small loopback HTTP fault fixtures complement, but never replace, the real RustFS gate.
use std::time::Duration;

use hyori_storage::{ObjectStorage, PartRef, StorageConfig, StorageError};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use uuid::Uuid;

struct Fixture {
    storage: ObjectStorage,
    task: Option<JoinHandle<Vec<(String, String)>>>,
}

impl Fixture {
    async fn start(responses: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let storage = ObjectStorage::new(StorageConfig {
            endpoint,
            region: "us-east-1".into(),
            bucket: "hyori-http-fault-fixture".into(),
            access_key_id: Uuid::new_v4().simple().to_string(),
            secret_access_key: Uuid::new_v4().simple().to_string(),
        })
        .unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                let header_end = loop {
                    let count = connection.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                    assert!(request.len() < 1024 * 1024);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while request.len() < header_end + length {
                    let count = connection.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let mut line = headers.lines().next().unwrap().split_whitespace();
                // Never retain or print signed headers/credentials.
                requests.push((
                    line.next().unwrap().to_owned(),
                    line.next().unwrap().to_owned(),
                ));
                if !response.is_empty() {
                    connection.write_all(response.as_bytes()).await.unwrap();
                }
                connection.shutdown().await.unwrap();
            }
            requests
        });
        Self {
            storage,
            task: Some(task),
        }
    }

    async fn methods(mut self, expected: &[&str]) {
        let requests = tokio::time::timeout(Duration::from_secs(3), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            expected
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn error(status: u16, code: &str) -> String {
    response(
        status,
        &format!("<Error><Code>{code}</Code><Message>fixture</Message></Error>"),
    )
}

fn head(length: u64) -> String {
    format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n")
}

fn parts() -> [PartRef; 1] {
    [PartRef {
        part_number: 1,
        etag: "\"fixture-etag\"".into(),
    }]
}

#[tokio::test]
async fn ensure_bucket_creates_only_after_a_404() {
    let fixture = Fixture::start(vec![response(404, ""), response(200, "")]).await;
    fixture.storage.ensure_bucket().await.unwrap();
    fixture.methods(&["HEAD", "PUT"]).await;
}

#[tokio::test]
async fn ensure_bucket_does_not_create_or_retry_on_permissions_redirects_or_outages() {
    for status in [301, 403, 500, 503] {
        let fixture = Fixture::start(vec![response(status, "")]).await;
        assert!(fixture.storage.ensure_bucket().await.is_err());
        fixture.methods(&["HEAD"]).await;
    }
}

#[tokio::test]
async fn abort_tolerates_only_true_no_such_upload_not_generic_404_or_missing_bucket() {
    let fixture = Fixture::start(vec![error(404, "NoSuchUpload")]).await;
    fixture
        .storage
        .abort("owners/fault/key", "durable-id")
        .await
        .unwrap();
    fixture.methods(&["DELETE"]).await;
    for reply in [
        response(404, ""),
        error(404, "NoSuchBucket"),
        error(403, "AccessDenied"),
        error(503, "SlowDown"),
    ] {
        let fixture = Fixture::start(vec![reply]).await;
        assert!(
            fixture
                .storage
                .abort("owners/fault/key", "durable-id")
                .await
                .is_err()
        );
        fixture.methods(&["DELETE"]).await;
    }
}

#[tokio::test]
async fn completion_does_not_reconcile_definite_part_or_authorization_errors() {
    for (status, code) in [
        (400, "InvalidPart"),
        (400, "InvalidPartOrder"),
        (403, "AccessDenied"),
        (404, "NoSuchBucket"),
    ] {
        let fixture = Fixture::start(vec![error(status, code)]).await;
        assert!(
            fixture
                .storage
                .complete("owners/fault/key", "durable-id", &parts(), 3)
                .await
                .is_err()
        );
        fixture.methods(&["POST"]).await;
    }
}

#[tokio::test]
async fn ambiguous_completion_and_missing_upload_reconcile_only_exact_size() {
    for reply in [
        error(500, "InternalError"),
        error(404, "NoSuchUpload"),
        String::new(),
    ] {
        let fixture = Fixture::start(vec![reply, head(3)]).await;
        assert_eq!(
            fixture
                .storage
                .complete("owners/fault/key", "durable-id", &parts(), 3)
                .await
                .unwrap()
                .size,
            3
        );
        fixture.methods(&["POST", "HEAD"]).await;
    }
    let fixture = Fixture::start(vec![error(404, "NoSuchUpload"), head(4)]).await;
    assert!(
        fixture
            .storage
            .complete("owners/fault/key", "durable-id", &parts(), 3)
            .await
            .is_err()
    );
    fixture.methods(&["POST", "HEAD"]).await;
}

#[tokio::test]
async fn ambiguous_completion_with_head_outage_is_a_failure() {
    let fixture = Fixture::start(vec![error(500, "InternalError"), response(503, "")]).await;
    assert!(
        fixture
            .storage
            .complete("owners/fault/key", "durable-id", &parts(), 3)
            .await
            .is_err()
    );
    fixture.methods(&["POST", "HEAD"]).await;
}

#[tokio::test]
async fn successful_completion_still_requires_exact_head_length() {
    let completed = response(
        200,
        "<CompleteMultipartUploadResult><ETag>\"fixture\"</ETag></CompleteMultipartUploadResult>",
    );
    let fixture = Fixture::start(vec![completed, head(4)]).await;
    assert!(matches!(
        fixture
            .storage
            .complete("owners/fault/key", "durable-id", &parts(), 3)
            .await,
        Err(StorageError::SizeMismatch {
            expected: 3,
            actual: 4
        })
    ));
    fixture.methods(&["POST", "HEAD"]).await;
}

#[tokio::test]
async fn truncated_download_surfaces_stream_failure_instead_of_eof_success() {
    use futures_util::StreamExt;
    let fixture = Fixture::start(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nab".into(),
    ])
    .await;
    let mut result = fixture
        .storage
        .read("owners/fault/key", None)
        .await
        .unwrap();
    let mut failed = false;
    while let Some(chunk) = result.body.next().await {
        failed |= chunk.is_err();
    }
    assert!(failed);
    fixture.methods(&["GET"]).await;
}

#[tokio::test]
async fn objects_only_purge_fails_if_listing_escapes_owner_or_has_no_completion_flag() {
    for body in [
        "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>owners/neighbour/private</Key></Contents></ListBucketResult>",
        "<ListBucketResult></ListBucketResult>",
    ] {
        let fixture = Fixture::start(vec![response(200, body)]).await;
        assert!(matches!(
            fixture.storage.purge_owner_objects("fault").await,
            Err(StorageError::Protocol(_))
        ));
        fixture.methods(&["GET"]).await;
    }
}

#[tokio::test]
async fn range_download_rejects_missing_malformed_or_wrong_bounds_metadata() {
    for content_range in [
        None,
        Some("garbage"),
        Some("bytes 0-1/3"),
        Some("bytes 1-3/3"),
        Some("bytes 1-3/*"),
        Some("bytes 2-4/10"),
    ] {
        let header =
            content_range.map_or(String::new(), |value| format!("Content-Range: {value}\r\n"));
        let reply = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\n{header}Connection: close\r\n\r\nabc"
        );
        let fixture = Fixture::start(vec![reply]).await;
        assert!(matches!(
            fixture
                .storage
                .read("owners/fault/key", Some("bytes=1-3"))
                .await,
            Err(StorageError::Protocol(_))
        ));
        fixture.methods(&["GET"]).await;
    }
}

#[tokio::test]
async fn unfinished_filters_prefix_neighbours_even_on_a_conforming_s3_service() {
    let body = "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Upload><Key>owners/fault/key-neighbour</Key><UploadId>neighbour-id</UploadId></Upload><Upload><Key>owners/fault/key</Key><UploadId>exact-id</UploadId></Upload></ListMultipartUploadsResult>";
    let mut fixture = Fixture::start(vec![response(200, body), response(204, "")]).await;
    assert_eq!(
        fixture
            .storage
            .abort_unfinished("owners/fault/key", None)
            .await
            .unwrap()
            .aborted,
        1
    );
    let requests = tokio::time::timeout(Duration::from_secs(3), fixture.task.take().unwrap()).await;
    // The final action must address exactly this key, regardless of prefix-list contents.
    let requests = requests.unwrap().unwrap();
    let target = url::Url::parse(&format!("http://127.0.0.1{}", requests[1].1)).unwrap();
    assert_eq!(target.path(), "/hyori-http-fault-fixture/owners/fault/key");
    assert!(
        target
            .query_pairs()
            .any(|(name, value)| name == "uploadId" && value == "exact-id")
    );
}

#[tokio::test]
#[ignore = "two real 120-second part deadlines against loopback HTTP"]
async fn part_deadline_distinguishes_an_unfinished_source_from_a_storage_response_stall() {
    use futures_util::{StreamExt, stream};
    use hyori_storage::{Bytes, StorageStream};

    for slow_source in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let storage = ObjectStorage::new(StorageConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            region: "us-east-1".into(),
            bucket: "hyori-part-deadline".into(),
            access_key_id: Uuid::new_v4().simple().to_string(),
            secret_access_key: Uuid::new_v4().simple().to_string(),
        })
        .unwrap();
        // Consume everything sent, but withhold the storage response in both cases.
        let reader = tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            while connection.read(&mut buffer).await.unwrap_or(0) > 0 {}
        });
        let source: StorageStream = if slow_source {
            Box::pin(stream::iter(0..32).then(|_| async {
                tokio::time::sleep(Duration::from_secs(6)).await;
                Ok(Bytes::from_static(b"a"))
            }))
        } else {
            Box::pin(stream::once(async { Ok(Bytes::from(vec![b'a'; 32])) }))
        };
        let started = std::time::Instant::now();
        let result = storage
            .part("owners/fault/key", "upload", 1, 32, source)
            .await;

        if slow_source {
            assert!(
                matches!(result, Err(StorageError::PartDeadline)),
                "{result:?}"
            );
        } else {
            assert!(
                matches!(result, Err(StorageError::Transport { operation: "part" })),
                "{result:?}"
            );
        }
        assert!(started.elapsed() >= Duration::from_secs(119));
        assert!(started.elapsed() < Duration::from_secs(125));
        reader.abort();
        let _ = reader.await;
    }
}

#[tokio::test]
#[ignore = "two real 120-second part deadlines against storage that stops reading"]
async fn storage_backpressure_is_not_the_uploaders_slow_connection() {
    use futures_util::{StreamExt, stream};
    use hyori_storage::{Bytes, StorageStream};
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    use tokio::net::TcpSocket;

    const FRAME: usize = 64 * 1024;
    const FRAMES: u64 = 128;
    for trickling in [false, true] {
        // Accepted connections inherit this buffer: the kernel cannot absorb the whole 8 MiB.
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(8).unwrap();
        let storage = ObjectStorage::new(StorageConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            region: "us-east-1".into(),
            bucket: "hyori-part-backpressure".into(),
            access_key_id: Uuid::new_v4().simple().to_string(),
            secret_access_key: Uuid::new_v4().simple().to_string(),
        })
        .unwrap();
        let holder = tokio::spawn(async move {
            let (connection, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(600)).await;
            drop(connection);
        });
        let started = std::time::Instant::now();
        let taken = Arc::new(AtomicU64::new(0));
        let last_taken_ms = Arc::new(AtomicU64::new(0));
        let (count, last) = (taken.clone(), last_taken_ms.clone());
        let source: StorageStream = Box::pin(stream::iter(0..FRAMES).then(move |_| {
            let (count, last) = (count.clone(), last.clone());
            async move {
                if trickling {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                count.fetch_add(FRAME as u64, Ordering::Relaxed);
                last.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                Ok(Bytes::from(vec![b'a'; FRAME]))
            }
        }));
        let result = storage
            .part(
                "owners/fault/key",
                "upload",
                1,
                FRAMES * FRAME as u64,
                source,
            )
            .await;
        eprintln!(
            "storage stopped reading (trickling={trickling}): {result:?} after {:.1}s; polled {} of {} bytes, last at {}ms",
            started.elapsed().as_secs_f64(),
            taken.load(Ordering::Relaxed),
            FRAMES * FRAME as u64,
            last_taken_ms.load(Ordering::Relaxed),
        );
        holder.abort();
        let _ = holder.await;
        assert!(
            matches!(result, Err(StorageError::Transport { operation: "part" })),
            "storage backpressure must not blame the uploader: {result:?}"
        );
        assert!(taken.load(Ordering::Relaxed) < FRAMES * FRAME as u64);
        assert!(started.elapsed() >= Duration::from_secs(119));
        assert!(started.elapsed() < Duration::from_secs(125));
    }
}

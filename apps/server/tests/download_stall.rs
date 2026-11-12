#[path = "support/storage.rs"]
mod storage;
mod support;

use hyori_server::auth::random_token;
use serde_json::json;
use std::time::Duration;
use support::{Postgres, TestServer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SIZE: usize = 24 * 1024 * 1024;
const CHUNK: usize = 8 * 1024 * 1024;

async fn account(server: &TestServer, admin: &str, email: &str) -> String {
    let password = random_token();
    server
        .rpc(
            "admin.createUser",
            json!({"email":email,"name":"Reader","password":password}),
            Some(admin),
        )
        .await
        .value();
    server
        .rpc(
            "auth.login",
            json!({"email":email,"password":password}),
            None,
        )
        .await
        .credential()
}

async fn put(server: &TestServer, cookie: &str, id: &str, number: usize, body: Vec<u8>) -> u16 {
    server
        .client
        .put(format!("{}/api/storage/uploads/{id}/{number}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(body)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// Returns the begin, part and completion statuses, and the file id when every step succeeded.
async fn upload(server: &TestServer, cookie: &str, name: &str, size: usize) -> (Vec<u16>, String) {
    let begun = server
        .rpc(
            "uploads.begin",
            json!({"parentId":null,"name":name,"size":size,"mimeType":"application/octet-stream"}),
            Some(cookie),
        )
        .await;
    let mut statuses = vec![begun.status];
    if begun.status != 200 {
        return (statuses, String::new());
    }
    let id = begun.value()["uploadId"].as_str().unwrap().to_owned();
    for (index, start) in (0..size.max(1)).step_by(CHUNK).enumerate() {
        let length = CHUNK.min(size - start);
        statuses.push(put(server, cookie, &id, index + 1, vec![b'x'; length]).await);
    }
    let completed = server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await;
    statuses.push(completed.status);
    let file = if completed.status == 200 {
        completed.value()["id"].as_str().unwrap().to_owned()
    } else {
        String::new()
    };
    (statuses, file)
}

/// A client that sends a download request, reads the status line, and then never reads again.
/// A small receive buffer makes the server's writes block quickly, as for a stalled visitor.
async fn stalled_reader(
    server: &TestServer,
    cookie: &str,
    id: &str,
) -> (tokio::net::TcpStream, u16) {
    let address: std::net::SocketAddr = server.url.trim_start_matches("http://").parse().unwrap();
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(4096).unwrap();
    let mut stream = socket.connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "GET /api/storage/files/{id} HTTP/1.1\r\nHost: localhost:3001\r\nOrigin: http://localhost:3001\r\nCookie: {cookie}\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = [0_u8; 12];
    stream.read_exact(&mut head).await.unwrap();
    let status = std::str::from_utf8(&head[9..12]).unwrap().parse().unwrap();
    (stream, status)
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS: non-reading downloads must not exhaust shared transfer admission"]
async fn sixteen_stalled_downloads_do_not_block_other_uploads_or_downloads() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup", json!({"email":"stall@example.test","name":"Stall owner","password":random_token(),"setupToken":server.state.config.setup_token}), None).await;
    assert!(setup.cookie.is_some());
    let owner = setup.credential();
    setup.value();
    let other = account(&server, &owner, "reader@example.test").await;

    let (statuses, large) = upload(&server, &owner, "large.bin", SIZE).await;
    assert!(statuses.iter().all(|status| *status == 200), "{statuses:?}");
    let (statuses, small) = upload(&server, &other, "small.bin", 3).await;
    assert!(statuses.iter().all(|status| *status == 200), "{statuses:?}");

    // Opened together: excess requests wait briefly for the owner's slots, then fail.
    let stalled =
        futures_util::future::join_all((0..16).map(|_| stalled_reader(&server, &owner, &large)))
            .await;
    let admitted = stalled.iter().filter(|(_, status)| *status == 200).count();
    eprintln!("stalled readers admitted: {admitted} of 16");
    assert_eq!(
        admitted,
        hyori_server::config::DOWNLOADS_PER_PRINCIPAL,
        "one principal's excess downloads must not be admitted while its slots are stalled"
    );
    // Let every admitted response fill its socket and stop being polled.
    tokio::time::sleep(Duration::from_secs(2)).await;

    let started = std::time::Instant::now();
    let (statuses, _) = tokio::time::timeout(
        Duration::from_secs(10),
        upload(&server, &other, "unrelated.bin", 3),
    )
    .await
    .expect("an unrelated upload must not wait for stalled readers");
    eprintln!("unrelated upload statuses: {statuses:?}");
    assert!(
        statuses.iter().all(|status| *status == 200),
        "unrelated upload was refused while stalled downloads held admission: {statuses:?}"
    );
    let download = tokio::time::timeout(
        Duration::from_secs(10),
        server
            .client
            .get(format!("{}/api/storage/files/{small}", server.url))
            .header("host", "localhost:3001")
            .header("origin", &server.state.config.origin)
            .header("cookie", &other)
            .send(),
    )
    .await
    .expect("an unrelated download must not wait for stalled readers")
    .unwrap();
    let status = download.status().as_u16();
    eprintln!("unrelated download status: {status}");
    assert_eq!(
        status, 200,
        "unrelated download was refused while stalled downloads held admission"
    );
    assert_eq!(download.bytes().await.unwrap().as_ref(), b"xxx");
    eprintln!("unrelated work finished in {:?}", started.elapsed());
    // The stalled sockets stay open, but their producers give up after the idle bound and free the
    // owner's admission: a ranged read of the same file is admitted again without closing them.
    let recovered = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let response = server
                .client
                .get(format!("{}/api/storage/files/{large}", server.url))
                .header("host", "localhost:3001")
                .header("origin", &server.state.config.origin)
                .header("cookie", &owner)
                .header("range", "bytes=0-2")
                .send()
                .await
                .unwrap();
            if response.status() == 206 {
                assert_eq!(
                    response.headers()["content-range"],
                    format!("bytes 0-2/{SIZE}")
                );
                return (response.bytes().await.unwrap(), started.elapsed());
            }
            assert_eq!(response.status(), 503);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("stalled readers must release their admission after the idle bound");
    assert_eq!(recovered.0.as_ref(), b"xxx");
    eprintln!(
        "owner admitted again after {:?} with stalled sockets still open",
        recovered.1
    );
    server
        .rpc("uploads.incoming", json!({}), None)
        .await
        .error(401, "auth.required");
    drop(stalled);
    pg.stop();
}

use super::{
    begin, complete, put, setup, storage,
    support::{Postgres, TestServer},
};
use serde_json::{Value, json};

async fn fetch(
    server: &TestServer,
    cookie: &str,
    url: &str,
    range: Option<&str>,
) -> reqwest::Response {
    let request = server
        .client
        .get(format!("{}{url}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie);
    let request = if let Some(range) = range {
        request.header("range", range)
    } else {
        request
    };
    request.send().await.unwrap()
}

async fn descriptor(server: &TestServer, cookie: &str, id: &str) -> Value {
    server
        .rpc("files.download", json!({"id":id}), Some(cookie))
        .await
        .value()
        .clone()
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS descriptor-replacement-GET coherence and fresh authorization"]
async fn descriptors_condition_current_content_but_do_not_grant_history_or_survive_revocation() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let (_, cookie) = setup(&server).await;
    let upload = begin(&server, &cookie, "revision.bin", 3, None, None).await;
    assert!(
        put(&server, &cookie, &upload, b"aaa")
            .await
            .status()
            .is_success()
    );
    let file = complete(&server, &cookie, &upload).await;
    let id = file["id"].as_str().unwrap();
    let first = descriptor(&server, &cookie, id).await;
    let first_url = first["url"].as_str().unwrap();
    assert!(first_url.contains("?revision="));

    let replacement = begin(&server, &cookie, "revision.bin", 5, None, Some(id)).await;
    assert!(
        put(&server, &cookie, &replacement, b"bbbbb")
            .await
            .status()
            .is_success()
    );
    complete(&server, &cookie, &replacement).await;
    let stale = fetch(&server, &cookie, first_url, None).await;
    assert_eq!(stale.status(), 409);
    assert_eq!(
        stale.json::<Value>().await.unwrap()["error"]["code"],
        "resource.conflict"
    );
    let second = descriptor(&server, &cookie, id).await;
    let second_url = second["url"].as_str().unwrap();
    assert_eq!(second["size"], 5);
    let range = fetch(&server, &cookie, second_url, Some("bytes=1-3")).await;
    assert_eq!(range.status(), 206);
    assert_eq!(range.headers()["content-length"], "3");
    assert_eq!(range.bytes().await.unwrap().as_ref(), b"bbb");

    let same_size = begin(&server, &cookie, "revision.bin", 5, None, Some(id)).await;
    assert!(
        put(&server, &cookie, &same_size, b"ccccc")
            .await
            .status()
            .is_success()
    );
    complete(&server, &cookie, &same_size).await;
    assert_eq!(
        fetch(&server, &cookie, second_url, None).await.status(),
        409
    );
    let current = descriptor(&server, &cookie, id).await;
    let current_url = current["url"].as_str().unwrap();
    assert_eq!(
        fetch(&server, &cookie, current_url, None)
            .await
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        b"ccccc"
    );

    let versions = server
        .rpc("files.versions", json!({"id":id}), Some(&cookie))
        .await
        .value()
        .clone();
    let version = versions["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|version| version["size"] == 3)
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let historical = server
        .rpc(
            "files.download",
            json!({"id":id,"versionId":version}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let history_url = historical["url"].as_str().unwrap();
    assert!(history_url.contains("?version="));
    assert!(!history_url.contains("revision="));
    assert_eq!(
        fetch(&server, &cookie, history_url, None)
            .await
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        b"aaa"
    );
    assert_eq!(
        fetch(
            &server,
            &cookie,
            &format!("{current_url}&version={version}"),
            None
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        fetch(
            &server,
            &cookie,
            &format!("/api/storage/files/{id}?revision=-1"),
            None
        )
        .await
        .status(),
        400
    );

    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":id,"public":true,"role":"viewer"}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let token = link["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await
        .credential();
    let shared = descriptor(&server, &grant, id).await;
    assert!(
        fetch(&server, &grant, shared["url"].as_str().unwrap(), None)
            .await
            .status()
            .is_success()
    );
    assert!(matches!(
        fetch(&server, &grant, history_url, None)
            .await
            .status()
            .as_u16(),
        403 | 404
    ));
    server
        .rpc("shares.revoke", json!({"id":link["id"]}), Some(&cookie))
        .await
        .value();
    assert!(matches!(
        fetch(&server, &grant, shared["url"].as_str().unwrap(), None)
            .await
            .status()
            .as_u16(),
        403 | 404
    ));
}

#[path = "support/media_storage_proxy.rs"]
mod media_storage_proxy;
#[path = "support/media_worker.rs"]
mod media_worker;
#[path = "support/storage.rs"]
mod storage;
mod support;
use hyori_media_worker::{MAX_INPUT, MAX_OUTPUT, webp_dimensions};
use hyori_server::{
    auth::random_token,
    db::sql,
    features::{
        admin::purge,
        media::{cleanup, jobs},
    },
};
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use support::{Postgres, TestServer};

const FIXTURES: [(&str, &str, &[u8]); 8] = [
    (
        "red.png",
        "image/png",
        include_bytes!("fixtures/media/red.png"),
    ),
    (
        "red.jpg",
        "image/jpeg",
        include_bytes!("fixtures/media/red.jpg"),
    ),
    (
        "red.webp",
        "image/webp",
        include_bytes!("fixtures/media/red.webp"),
    ),
    (
        "red.gif",
        "image/gif",
        include_bytes!("fixtures/media/red.gif"),
    ),
    (
        "red.avif",
        "image/avif",
        include_bytes!("fixtures/media/red.avif"),
    ),
    (
        "red.mp4",
        "video/mp4",
        include_bytes!("fixtures/media/red.mp4"),
    ),
    (
        "red.webm",
        "video/webm",
        include_bytes!("fixtures/media/red.webm"),
    ),
    (
        "red.mov",
        "video/quicktime",
        include_bytes!("fixtures/media/red.mov"),
    ),
];
async fn upload(
    server: &TestServer,
    cookie: &str,
    parent: Option<&str>,
    name: &str,
    mime: &str,
    bytes: &[u8],
    replace: Option<&str>,
) -> Value {
    let mut input = json!({"parentId":parent,"name":name,"mimeType":mime,"size":bytes.len()});
    if let Some(id) = replace {
        input["replaceId"] = json!(id);
    }
    let started = server.rpc("uploads.begin", input, Some(cookie)).await;
    let id = started.value()["uploadId"].as_str().unwrap();
    let response = server
        .client
        .put(format!("{}/api/storage/uploads/{id}/1", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    server
        .rpc("uploads.complete", json!({"uploadId":id}), Some(cookie))
        .await
        .value()
        .clone()
}
async fn get(server: &TestServer, cookie: &str, path: &str) -> reqwest::Response {
    server
        .client
        .get(format!("{}{path}", server.url))
        .header("host", "localhost:3001")
        .header("origin", &server.state.config.origin)
        .header("cookie", cookie)
        .send()
        .await
        .unwrap()
}
async fn count(server: &TestServer, query: &str) -> i64 {
    server
        .state
        .db
        .query_one_raw(sql(query, vec![]))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "count")
        .unwrap()
}
async fn due(server: &TestServer) {
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET due_at=now(); UPDATE hyori_media_artifacts SET cleanup_due=now() WHERE checked_at IS NULL; UPDATE hyori_account_purges SET due_at=now(); UPDATE hyori_uploads SET cleanup_due=now() WHERE purge_checked_at IS NULL").await.unwrap();
}

#[test]
#[ignore = "real container refuses decoder startup without required isolation"]
fn worker_refuses_unisolated_runtime() {
    let image = std::env::var("HYORI_MEDIA_TEST_IMAGE").unwrap();
    let output = std::process::Command::new("docker")
        .args([
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "10001:10001",
            &image,
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("isolation requirements"));
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker lost derivative begin and expired job lease"]
async fn derivative_intents_survive_lost_begin_and_expired_processing_lease() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    let proxy = media_storage_proxy::Proxy::start(fs.config.endpoint.clone()).await;
    let mut config = fs.config.clone();
    config.endpoint = proxy.endpoint.clone();
    pg.config.storage = Some(config);
    pg.config.media_worker_socket = Some(worker.socket.clone());
    let server = TestServer::start(pg.config.clone()).await;
    let admin=server.rpc("auth.setup",json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}),None).await;
    let cookie = admin.credential();
    let file = upload(
        &server,
        &cookie,
        None,
        "original.png",
        "image/png",
        FIXTURES[0].2,
        None,
    )
    .await;
    server
        .rpc("media.retry", json!({"id":file["id"]}), Some(&cookie))
        .await
        .value();
    server.state.db.execute_unprepared("UPDATE hyori_media_jobs SET state='processing',attempts=1,lease_token='lost-process',lease_until=now()-interval '1 second'").await.unwrap();
    proxy
        .lose_begin
        .store(true, std::sync::atomic::Ordering::SeqCst);
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(count(&server,"SELECT count(*) AS count FROM hyori_media_artifacts WHERE state='aborted' AND multipart_id IS NULL").await,1);
    let row = server
        .state
        .db
        .query_one_raw(sql("SELECT object_key FROM hyori_media_artifacts", vec![]))
        .await
        .unwrap()
        .unwrap();
    let abandoned: String = row.try_get("", "object_key").unwrap();
    let direct = hyori_storage::ObjectStorage::new(fs.config.clone()).unwrap();
    assert!(
        !direct
            .unfinished(&abandoned)
            .await
            .unwrap()
            .uploads
            .is_empty(),
        "real begin happened before its response was lost"
    );
    proxy
        .lose_begin
        .store(false, std::sync::atomic::Ordering::SeqCst);
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(
        direct
            .unfinished(&abandoned)
            .await
            .unwrap()
            .uploads
            .is_empty()
    );
    due(&server).await;
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(
        server
            .rpc("media.get", json!({"id":file["id"]}), Some(&cookie))
            .await
            .value()["status"],
        "ready"
    );
    assert_eq!(
        count(
            &server,
            "SELECT count(*) AS count FROM hyori_media_artifacts"
        )
        .await,
        2
    );
    assert_eq!(
        count(
            &server,
            "SELECT attempts::bigint AS count FROM hyori_media_jobs"
        )
        .await,
        3
    );
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&cookie))
            .await
            .value()["user"]["usedBytes"],
        101
    );
    assert!(direct.head(&abandoned).await.is_err());
    pg.stop();
}

#[tokio::test]
#[ignore = "real network-disabled nonroot read-only resource-bounded FFmpeg worker container"]
async fn isolated_worker_decodes_eight_formats_strips_metadata_and_enforces_bounds() {
    let worker = media_worker::Worker::start().await;
    let inspection = worker.inspect();
    let config = &inspection[0]["HostConfig"];
    assert_eq!(config["NetworkMode"], "none");
    assert_eq!(config["ReadonlyRootfs"], true);
    assert_eq!(config["Memory"], 536870912_i64);
    assert_eq!(config["PidsLimit"], 64);
    assert!(
        !inspection[0]["Config"]["Env"]
            .to_string()
            .contains("HYORI_STORAGE")
    );
    assert!(
        !inspection[0]["Config"]["User"]
            .as_str()
            .unwrap()
            .starts_with("0:")
    );
    let client = worker.client();
    for (name, mime, bytes) in FIXTURES {
        let response = client
            .post("http://localhost/v1/derive")
            .header("content-length", bytes.len())
            .header("x-hyori-media-type", mime)
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            200,
            "{name}: {}",
            response.text().await.unwrap_or_default()
        );
        let response = client
            .post("http://localhost/v1/derive")
            .header("content-length", bytes.len())
            .header("x-hyori-media-type", mime)
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        let output = response.bytes().await.unwrap();
        assert!(output.len() <= MAX_OUTPUT);
        assert!(webp_dimensions(&output).is_some());
        worker.decode_output(&output);
    }
    for original in [
        include_bytes!("fixtures/media/capture.jpg").as_slice(),
        include_bytes!("fixtures/media/capture-piexif.jpg").as_slice(),
    ] {
        let response = client
            .post("http://localhost/v1/capture")
            .header("x-hyori-media-type", "image/jpeg")
            .body(original.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"time":{"local":"2018-07-04T23:32:10","offset_minutes":null},
                   "location":{"latitude":-33.75,"longitude":151.125}}),
        );
    }
    let oriented = include_bytes!("fixtures/media/oriented.jpg");
    let response = client
        .post("http://localhost/v1/derive")
        .header("content-length", oriented.len())
        .header("x-hyori-media-type", "image/jpeg")
        .body(oriented.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let bytes = response.bytes().await.unwrap();
    assert_eq!(webp_dimensions(&bytes), Some((16, 32)));
    assert!(!bytes.windows(4).any(|w| w == b"Exif"));
    worker.decode_output(&bytes);
    for (mime, bytes) in [
        ("image/png", b"<html><script>bad</script>".as_slice()),
        ("image/svg+xml", b"<svg/>"),
        ("image/jpeg", FIXTURES[0].2),
        (
            "image/png",
            include_bytes!("fixtures/media/over-pixels.png").as_slice(),
        ),
        (
            "video/mp4",
            include_bytes!("fixtures/media/over-duration.mp4").as_slice(),
        ),
    ] {
        let response = client
            .post("http://localhost/v1/derive")
            .header("content-length", bytes.len())
            .header("x-hyori-media-type", mime)
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "{mime}");
    }
    let response = client
        .post("http://localhost/v1/derive")
        .header("content-length", MAX_INPUT + 1)
        .header("x-hyori-media-type", "image/png")
        .body(reqwest::Body::wrap_stream(futures_util::stream::pending::<
            Result<hyori_storage::Bytes, std::io::Error>,
        >()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 422);
    let request = client
        .post("http://localhost/v1/derive")
        .header("content-length", 101)
        .header("x-hyori-media-type", "image/png")
        .body(reqwest::Body::wrap_stream(futures_util::stream::pending::<
            Result<hyori_storage::Bytes, std::io::Error>,
        >()))
        .send();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), request)
            .await
            .is_err()
    );
    for _ in 0..100 {
        if worker.scratch_count().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        worker.scratch_count().is_empty(),
        "cancelled input leaves no scratch files"
    );
    worker.stop();
    worker.restart().await;
    let response = worker
        .client()
        .post("http://localhost/v1/derive")
        .header("x-hyori-media-type", "image/png")
        .body(FIXTURES[0].2.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
#[ignore = "real isolated FFmpeg worker with colour-tagged still images"]
async fn isolated_worker_derives_colour_tagged_stills_without_output_metadata() {
    let worker = media_worker::Worker::start().await;
    let client = worker.client();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../media-worker/tests/fixtures/colour");
    let mut failures = Vec::new();
    for (name, mime) in [
        ("srgb.png", "image/png"),
        ("gamma.png", "image/png"),
        ("chroma.png", "image/png"),
        ("cicp.png", "image/png"),
        ("combined.png", "image/png"),
        ("plain.png", "image/png"),
        ("icc.webp", "image/webp"),
        ("icc.gif", "image/gif"),
        ("srgb.avif", "image/avif"),
        ("icc.jpg", "image/jpeg"),
    ] {
        let source = std::fs::read(directory.join(name)).unwrap();
        let response = client
            .post("http://localhost/v1/derive")
            .header("x-hyori-media-type", mime)
            .body(source)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let mime = response.headers()["content-type"].clone();
        let width = response.headers().get("x-hyori-width").cloned();
        let height = response.headers().get("x-hyori-height").cloned();
        let bytes = response.bytes().await.unwrap();
        println!("{name}: {status}, {mime:?}, {} bytes", bytes.len());
        if status != 200 {
            failures.push(format!(
                "{name}: {status}: {}",
                String::from_utf8_lossy(&bytes)
            ));
            continue;
        }
        if mime != "image/webp" || webp_dimensions(&bytes) != Some((244, 183)) {
            failures.push(format!("{name}: unexpected thumbnail envelope or geometry"));
            continue;
        }
        assert_eq!(width.unwrap(), "244", "{name}");
        assert_eq!(height.unwrap(), "183", "{name}");
        worker.decode_output(&bytes);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
#[ignore = "real PostgreSQL/RustFS/isolated worker media lifecycle and purge"]
async fn durable_derivatives_preserve_originals_scope_restore_quota_and_purge_late_work() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let worker = media_worker::Worker::start().await;
    pg.config.storage = Some(fs.config.clone());
    pg.config.media_worker_socket = Some(worker.socket.clone());
    let mut server = TestServer::start(pg.config.clone()).await;
    let admin=server.rpc("auth.setup",json!({"setupToken":pg.config.setup_token,"email":"admin@example.test","name":"Admin","password":random_token()}),None).await;
    assert!(admin.cookie.is_some());
    let admin_cookie = admin.credential();
    let admin_id = admin.value()["id"].clone();
    let password = random_token();
    let owner = server
        .rpc(
            "admin.createUser",
            json!({"email":"owner@example.test","name":"Owner","password":password}),
            Some(&admin_cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":"owner@example.test","password":password}),
            None,
        )
        .await
        .credential();
    server
        .rpc(
            "photos.setSources",
            json!({"allMyFiles":true,"folderIds":[]}),
            Some(&cookie),
        )
        .await
        .value();
    let mut files = Vec::new();
    for (name, mime, bytes) in FIXTURES {
        files.push(upload(&server, &cookie, None, name, mime, bytes, None).await);
    }
    let published = count(&server, "SELECT count(*) AS count FROM hyori_media_jobs").await;
    assert_eq!(
        published,
        FIXTURES.len() as i64,
        "publication enqueues one job per media file"
    );
    for file in &files {
        assert_eq!(
            server
                .rpc("media.get", json!({"id":file["id"]}), Some(&cookie))
                .await
                .value()["status"],
            "queued"
        );
    }
    let timeline = server
        .rpc("photos.timeline", json!({}), Some(&cookie))
        .await;
    assert!(
        timeline.value()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["derivative"]["status"] == "queued")
    );
    assert_eq!(
        count(&server, "SELECT count(*) AS count FROM hyori_media_jobs").await,
        published,
        "query/refetch never starts work"
    );
    for _ in 0..8 {
        assert!(jobs::run_once(&server.state).await.unwrap());
    }
    for (file, (_, _, original)) in files.iter().zip(FIXTURES) {
        let media = server
            .rpc("media.get", json!({"id":file["id"]}), Some(&cookie))
            .await;
        assert_eq!(media.value()["status"], "ready", "{}", media.body);
        let response = get(&server, &cookie, media.value()["url"].as_str().unwrap()).await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/webp");
        assert_eq!(response.headers()["cache-control"], "private, no-cache");
        assert!(response.headers().contains_key("etag"));
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        let bytes = response.bytes().await.unwrap();
        worker.decode_output(&bytes);
        let original_url = server
            .rpc("files.preview", json!({"id":file["id"]}), Some(&cookie))
            .await;
        let response = get(
            &server,
            &cookie,
            original_url.value()["url"].as_str().unwrap(),
        )
        .await;
        assert_eq!(response.bytes().await.unwrap().as_ref(), original);
    }
    let missing_id = files[1]["id"].as_str().unwrap();
    let lost_key=server.state.db.query_one_raw(sql("SELECT a.object_key FROM hyori_media_artifacts a JOIN hyori_media_jobs j ON j.artifact_id=a.id JOIN hyori_items i ON i.object_key=j.source_key WHERE i.id=$1",vec![missing_id.into()])).await.unwrap().unwrap().try_get::<String>("","object_key").unwrap();
    let repair_storage = hyori_storage::ObjectStorage::new(fs.config.clone()).unwrap();
    let lost_metadata = server
        .rpc("media.get", json!({"id":missing_id}), Some(&cookie))
        .await;
    repair_storage.remove(&lost_key).await.unwrap();
    assert_eq!(
        get(
            &server,
            &cookie,
            lost_metadata.value()["url"].as_str().unwrap()
        )
        .await
        .status(),
        503
    );
    assert_eq!(
        server
            .rpc("media.get", json!({"id":missing_id}), Some(&cookie))
            .await
            .value()["status"],
        "ready",
        "failed GET and metadata refetch do not mutate the published record or enqueue work"
    );
    assert_eq!(
        count(
            &server,
            "SELECT count(*) AS count FROM hyori_media_jobs WHERE state='queued'"
        )
        .await,
        0
    );
    cleanup::reclaim(&server.state).await.unwrap();
    assert_eq!(
        server
            .rpc("media.get", json!({"id":missing_id}), Some(&cookie))
            .await
            .value()["status"],
        "queued",
        "maintenance repairs a genuinely missing cache within the attempt budget"
    );
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(
        server
            .rpc("media.get", json!({"id":missing_id}), Some(&cookie))
            .await
            .value()["status"],
        "ready"
    );
    let original_size: u64 = FIXTURES
        .iter()
        .map(|(_, _, bytes)| bytes.len() as u64)
        .sum();
    assert_eq!(
        server
            .rpc("auth.status", json!({}), Some(&cookie))
            .await
            .value()["user"]["usedBytes"],
        original_size
    );
    assert_eq!(
        count(&server, "SELECT count(*) AS count FROM hyori_objects").await,
        8
    );
    let first_id = files[0]["id"].as_str().unwrap();
    let old = server
        .rpc("media.get", json!({"id":first_id}), Some(&cookie))
        .await
        .value()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .rpc("media.get", json!({"id":first_id}), Some(&admin_cookie))
        .await
        .error(403, "access.denied");
    assert_eq!(get(&server, &admin_cookie, &old).await.status(), 403);
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":first_id,"recipientId":admin_id,"public":false,"role":"viewer"}),
            Some(&cookie),
        )
        .await;
    server
        .rpc("media.retry", json!({"id":first_id}), Some(&admin_cookie))
        .await
        .value();
    assert_eq!(get(&server, &admin_cookie, &old).await.status(), 200);
    server
        .rpc(
            "shares.revoke",
            json!({"id":share.value()["id"]}),
            Some(&cookie),
        )
        .await
        .value();
    assert_eq!(get(&server, &admin_cookie, &old).await.status(), 403);
    upload(
        &server,
        &cookie,
        None,
        "red.png",
        "image/gif",
        FIXTURES[3].2,
        Some(first_id),
    )
    .await;
    assert_eq!(get(&server, &cookie, &old).await.status(), 404);
    assert_eq!(
        server
            .rpc("media.get", json!({"id":first_id}), Some(&cookie))
            .await
            .value()["status"],
        "queued"
    );
    jobs::run_once(&server.state).await.unwrap();
    let version = server
        .rpc("files.versions", json!({"id":first_id}), Some(&cookie))
        .await
        .value()["items"][0]["id"]
        .clone();
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":first_id,"versionId":version}),
            Some(&cookie),
        )
        .await
        .value();
    let restored = server
        .rpc("media.get", json!({"id":first_id}), Some(&cookie))
        .await;
    assert_eq!(restored.value()["status"], "ready");
    assert_eq!(
        restored.value()["url"].as_str().unwrap().split('?').next(),
        old.split('?').next()
    );
    let invalid = upload(
        &server,
        &cookie,
        None,
        "fake.png",
        "image/png",
        b"<html>active content</html>",
        None,
    )
    .await;
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(
        server
            .rpc("media.get", json!({"id":invalid["id"]}), Some(&cookie))
            .await
            .value()["status"],
        "unsupported"
    );
    worker.stop();
    let outage = upload(
        &server,
        &cookie,
        None,
        "outage.png",
        "image/png",
        FIXTURES[0].2,
        None,
    )
    .await;
    for _ in 0..3 {
        due(&server).await;
        jobs::run_once(&server.state).await.unwrap();
    }
    assert_eq!(
        server
            .rpc("media.get", json!({"id":outage["id"]}), Some(&cookie))
            .await
            .value()["status"],
        "failed"
    );
    worker.restart().await;
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    server
        .rpc("media.retry", json!({"id":outage["id"]}), Some(&cookie))
        .await
        .value();
    jobs::run_once(&server.state).await.unwrap();
    assert_eq!(
        server
            .rpc("media.get", json!({"id":outage["id"]}), Some(&cookie))
            .await
            .value()["status"],
        "ready"
    );
    // Retry pressed while the worker is still down: an outage must not spend the reader's three
    // explicit attempts. Four failing passes exceed that budget; the job has to keep waiting.
    worker.stop();
    let pressed = upload(
        &server,
        &cookie,
        None,
        "outage-retried.png",
        "image/png",
        FIXTURES[0].2,
        None,
    )
    .await;
    for _ in 0..3 {
        due(&server).await;
        jobs::run_once(&server.state).await.unwrap();
    }
    for _ in 0..4 {
        server
            .rpc("media.retry", json!({"id":pressed["id"]}), Some(&cookie))
            .await
            .value();
        due(&server).await;
        jobs::run_once(&server.state).await.unwrap();
        assert_eq!(
            server
                .rpc("media.get", json!({"id":pressed["id"]}), Some(&cookie))
                .await
                .value()["status"],
            "queued"
        );
    }
    // The returning worker drops the backoff those presses earned, as it revives a failed job.
    worker.restart().await;
    for _ in 0..3 {
        jobs::run_once(&server.state).await.unwrap();
    }
    assert_eq!(
        server
            .rpc("media.get", json!({"id":pressed["id"]}), Some(&cookie))
            .await
            .value()["status"],
        "ready"
    );
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Shared destination"}),
            Some(&admin_cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .rpc(
            "shares.create",
            json!({"itemId":folder,"recipientId":owner,"public":false,"role":"contributor"}),
            Some(&admin_cookie),
        )
        .await
        .value();
    let contribution = upload(
        &server,
        &cookie,
        Some(&folder),
        "preserved.png",
        "image/png",
        FIXTURES[0].2,
        None,
    )
    .await;
    jobs::run_once(&server.state).await.unwrap();
    let preserved = server
        .rpc(
            "media.get",
            json!({"id":contribution["id"]}),
            Some(&admin_cookie),
        )
        .await
        .value()["url"]
        .as_str()
        .unwrap()
        .to_owned();
    let pending = upload(
        &server,
        &cookie,
        None,
        "pending.png",
        "image/png",
        FIXTURES[0].2,
        None,
    )
    .await;
    worker.pause();
    let generating = jobs::run_once(&server.state);
    let deleting = async {
        for _ in 0..100 {
            if count(
                &server,
                "SELECT count(*) AS count FROM hyori_media_jobs WHERE state='processing'",
            )
            .await
                > 0
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let deleted = server
            .rpc(
                "admin.deleteUser",
                json!({"userId":owner,"confirmEmail":"owner@example.test"}),
                Some(&admin_cookie),
            )
            .await;
        assert_eq!(
            deleted.value()["state"],
            "pending",
            "worker lease keeps deletion pending"
        );
        worker.resume();
    };
    let (generated, ()) = tokio::join!(generating, deleting);
    generated.unwrap();
    for _ in 0..10 {
        due(&server).await;
        purge::reclaim(&server.state).await.unwrap();
        if count(
            &server,
            "SELECT count(*) AS count FROM hyori_users WHERE status='deleting'",
        )
        .await
            == 0
        {
            break;
        }
    }
    assert_eq!(
        count(
            &server,
            "SELECT count(*) AS count FROM hyori_users WHERE status='deleted'"
        )
        .await,
        1
    );
    assert_eq!(get(&server, &admin_cookie, &preserved).await.status(), 200);
    server
        .rpc("media.get", json!({"id":pending["id"]}), Some(&cookie))
        .await
        .error(404, "resource.notFound");
    let rows = server
        .state
        .db
        .query_all_raw(sql(
            "SELECT object_key FROM hyori_media_artifacts WHERE owner_id=$1",
            vec![owner.clone().into()],
        ))
        .await
        .unwrap();
    assert!(!rows.is_empty());
    let direct = hyori_storage::ObjectStorage::new(fs.config.clone()).unwrap();
    for row in &rows {
        let key: String = row.try_get("", "object_key").unwrap();
        assert!(direct.head(&key).await.is_err());
    }
    let late_key: String = rows[0].try_get("", "object_key").unwrap();
    direct.begin(&late_key, "image/png").await.unwrap();
    assert!(
        !direct
            .unfinished(&late_key)
            .await
            .unwrap()
            .uploads
            .is_empty()
    );
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_media_artifacts SET cleanup_due=now() WHERE object_key=$1",
            vec![late_key.clone().into()],
        ))
        .await
        .unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(
        direct
            .unfinished(&late_key)
            .await
            .unwrap()
            .uploads
            .is_empty()
    );
    let late = direct.begin(&late_key, "image/png").await.unwrap();
    let bytes = hyori_storage::Bytes::from_static(FIXTURES[0].2);
    let etag = direct
        .part(
            &late_key,
            &late,
            1,
            bytes.len() as u64,
            Box::pin(futures_util::stream::once(async move { Ok(bytes) })),
        )
        .await
        .unwrap();
    direct
        .complete(
            &late_key,
            &late,
            &[hyori_storage::PartRef {
                part_number: 1,
                etag,
            }],
            101,
        )
        .await
        .unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_media_artifacts SET cleanup_due=now() WHERE object_key=$1",
            vec![late_key.clone().into()],
        ))
        .await
        .unwrap();
    cleanup::reclaim(&server.state).await.unwrap();
    assert!(direct.head(&late_key).await.is_err());
    assert_eq!(get(&server, &admin_cookie, &preserved).await.status(), 200);
    pg.stop();
}

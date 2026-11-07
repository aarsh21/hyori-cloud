#[path = "support/editor_assets_fixture.rs"]
mod fixture;
#[path = "support/storage.rs"]
mod storage;
mod support;
use fixture::BundleFixture;
use hyori_server::{
    auth::random_token,
    config::{Config, EditorAssetsConfig},
    db::sql,
    editor_assets::EditorAssets,
};
use sea_orm::ConnectionTrait;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
use support::{Postgres, TestServer};

fn config(fixture: &BundleFixture) -> Config {
    Config {
        database_url: format!("postgres://fixture:{}@127.0.0.1:1/fixture", random_token()),
        origin: "http://localhost:3001".into(),
        setup_token: random_token(),
        auth_secret: random_token(),
        secure_cookies: false,
        bind: "127.0.0.1:0".parse().unwrap(),
        default_quota_bytes: 100000,
        storage: None,
        media_worker_socket: None,
        editor_assets: Some(fixture.persist()),
    }
}
fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut writer = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), flate2::Compression::new(6));
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap()
}
fn sidecar_fixture(encoded: &[u8]) -> BundleFixture {
    let mut fixture = BundleFixture::new();
    fixture.manifest["schemaVersion"] = json!(2);
    for editor in fixture.manifest["editors"].as_array_mut().unwrap() {
        editor["role"] = json!("current");
    }
    let path = "wordcraft/0.14.0/fixture.js";
    let raw = b"// nonvendor fixture\n";
    fs::set_permissions(
        fixture.root.join("wordcraft/0.14.0"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(fixture.root.join(path), raw).unwrap();
    fs::write(fixture.root.join(format!("{path}.gz")), encoded).unwrap();
    let original = json!({"path":path,"bytes":raw.len(),"sha256":hex::encode(Sha256::digest(raw))});
    let zipped = json!({"path":format!("{path}.gz"),"bytes":encoded.len(),"sha256":hex::encode(Sha256::digest(encoded))});
    fixture.manifest["editors"][0]["files"]
        .as_array_mut()
        .unwrap()
        .push(original.clone());
    for mut file in [original.clone(), zipped.clone()] {
        file["contentType"] = json!("application/javascript");
        file["cacheControl"] = json!("no-cache");
        fixture.manifest["assets"]
            .as_array_mut()
            .unwrap()
            .push(file);
    }
    let mut sidecar = zipped;
    sidecar["encoding"] = json!("gzip");
    sidecar["encoder"] = json!("gzip-level6-mtime0-os255-v1");
    sidecar["original"] = original;
    fixture.manifest["transportSidecars"] = json!([sidecar]);
    fixture.persist();
    fixture
}
#[tokio::test]
async fn gzip_sidecars_preserve_raw_identity_and_reject_trailing_members_or_changed_decode() {
    let raw = b"// nonvendor fixture\n";
    let valid = gzip(raw);
    let fixture = sidecar_fixture(&valid);
    EditorAssets::load(&config(&fixture)).await.unwrap();
    for kind in [
        "empty-member",
        "trailing",
        "header",
        "crc",
        "oversized-decode",
        "changed-decode",
    ] {
        let mut encoded = valid.clone();
        match kind {
            "empty-member" => encoded.extend(gzip(b"")),
            "trailing" => encoded.push(0),
            "header" => encoded[9] = 3,
            "crc" => {
                let last = encoded.len() - 8;
                encoded[last] ^= 0xff;
            }
            "oversized-decode" => encoded = gzip(&vec![b'x'; 1024 * 1024]),
            "changed-decode" => encoded = gzip(&vec![b'x'; raw.len()]),
            _ => unreachable!(),
        }
        let fixture = sidecar_fixture(&encoded);
        assert!(
            EditorAssets::load(&config(&fixture)).await.is_err(),
            "{kind}"
        );
    }
    let mut fixture = sidecar_fixture(&valid);
    fixture.manifest["transportSidecars"][0]["original"]["sha256"] = json!("0".repeat(64));
    assert!(EditorAssets::load(&config(&fixture)).await.is_err());
}
fn rolling_fixture() -> BundleFixture {
    let mut fixture = BundleFixture::new();
    fixture.manifest["schemaVersion"] = json!(2);
    let mut current = Vec::new();
    let mut payload = Vec::new();
    for editor in fixture.manifest["editors"].as_array_mut().unwrap() {
        editor["role"] = json!("legacy");
        let app = editor["app"].as_str().unwrap().to_owned();
        let version = match app.as_str() {
            "wordcraft" => "0.14.0-hyori-host.1",
            "gridcraft" => "0.15.0-hyori-host.1",
            "deckcraft" => "0.14.1-hyori-host.3",
            _ => "0.17.0-hyori-host.1",
        };
        let path = format!("{app}/{version}/index.html");
        fs::set_permissions(fixture.root.join(&app), fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir(fixture.root.join(&app).join(version)).unwrap();
        fs::copy(
            fixture.root.join(editor["index"].as_str().unwrap()),
            fixture.root.join(&path),
        )
        .unwrap();
        let mut next = editor.clone();
        next["role"] = json!("current");
        next["version"] = json!(version);
        next["protocol"] = json!(2);
        next["bridge"] = json!("hyori-correlated-host-v2");
        next["index"] = json!(path);
        next["assetUrl"] = json!(format!("/artcraft/{path}?host=parent"));
        next["files"][0]["path"] = json!(path);
        let mut asset = next["files"][0].clone();
        asset["contentType"] = json!("text/html; charset=utf-8");
        asset["cacheControl"] = json!("no-store");
        current.push(next);
        payload.push(asset);
    }
    fixture.manifest["editors"]
        .as_array_mut()
        .unwrap()
        .extend(current);
    fixture.manifest["assets"]
        .as_array_mut()
        .unwrap()
        .extend(payload);
    fixture.persist();
    fixture
}
#[tokio::test]
async fn rolling_catalogue_accepts_one_current_and_one_legacy_per_app_only() {
    let mut fixture = rolling_fixture();
    EditorAssets::load(&config(&fixture)).await.unwrap();
    fixture.manifest["editors"][0]["role"] = json!("current");
    assert!(EditorAssets::load(&config(&fixture)).await.is_err());
    fixture.manifest["editors"][0]["role"] = json!("legacy");
    fixture.manifest["editors"][4]["role"] = json!("legacy");
    assert!(EditorAssets::load(&config(&fixture)).await.is_err());
    fixture.manifest["editors"][4]["role"] = json!("current");
    fixture.manifest["editors"][4]["protocol"] = json!(1);
    assert!(EditorAssets::load(&config(&fixture)).await.is_err());
}
#[tokio::test]
async fn read_only_synthetic_catalogue_requires_explicit_development_loopback_configuration() {
    let fixture = BundleFixture::new();
    let mut config = config(&fixture);
    EditorAssets::load(&config).await.unwrap();
    config.secure_cookies = true;
    config.origin = "https://cloud.example.test".into();
    assert!(EditorAssets::load(&config).await.is_err());
    config.secure_cookies = false;
    config.origin = "http://localhost:3001".into();
    config.bind = "0.0.0.0:3002".parse().unwrap();
    assert!(EditorAssets::load(&config).await.is_err());
    config.bind = "127.0.0.1:0".parse().unwrap();
    config.origin = "http://192.0.2.1:3001".into();
    assert!(EditorAssets::load(&config).await.is_err());
}
#[tokio::test]
async fn rejects_missing_changed_writable_symlink_extra_and_oversized_inventory() {
    for case in [
        "hash",
        "missing",
        "changed",
        "writable",
        "symlink",
        "extra",
        "absolute",
        "traversal",
        "duplicate",
        "bound",
        "url",
        "app-pin",
        "unlisted-index",
        "directory-symlink",
        "purpose",
    ] {
        let mut fixture = BundleFixture::new();
        let mut config = config(&fixture);
        let index = fixture.root.join("pdfcraft/0.17.0/index.html");
        match case {
            "hash" => config.editor_assets.as_mut().unwrap().manifest_sha256 = "0".repeat(64),
            "missing" => {
                fs::set_permissions(index.parent().unwrap(), fs::Permissions::from_mode(0o755))
                    .unwrap();
                fs::remove_file(&index).unwrap();
                fs::set_permissions(index.parent().unwrap(), fs::Permissions::from_mode(0o555))
                    .unwrap();
            }
            "changed" => {
                fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap();
                fs::write(&index, b"changed").unwrap();
                fs::set_permissions(&index, fs::Permissions::from_mode(0o444)).unwrap();
            }
            "writable" => fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap(),
            "symlink" => {
                fs::set_permissions(index.parent().unwrap(), fs::Permissions::from_mode(0o755))
                    .unwrap();
                fs::remove_file(&index).unwrap();
                symlink("/etc/passwd", &index).unwrap();
                fs::set_permissions(index.parent().unwrap(), fs::Permissions::from_mode(0o555))
                    .unwrap();
            }
            "extra" => {
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o755)).unwrap();
                let path = fixture.root.join("unlisted.js");
                fs::write(&path, b"bad").unwrap();
                fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o555)).unwrap();
            }
            "directory-symlink" => {
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o755)).unwrap();
                symlink("/etc", fixture.root.join("outside")).unwrap();
                fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o555)).unwrap();
            }
            _ => {
                match case {
                    "absolute" => fixture.manifest["assets"][0]["path"] = json!("/etc/passwd"),
                    "traversal" => {
                        fixture.manifest["assets"][0]["path"] = json!("wordcraft/../passwd")
                    }
                    "duplicate" => {
                        let duplicate = fixture.manifest["assets"][0].clone();
                        fixture.manifest["assets"]
                            .as_array_mut()
                            .unwrap()
                            .push(duplicate);
                    }
                    "bound" => {
                        fixture.manifest["assets"][0]["bytes"] = json!(128 * 1024 * 1024 + 1)
                    }
                    "url" => {
                        fixture.manifest["editors"][0]["assetUrl"] =
                            json!("https://example.test/index.html")
                    }
                    "app-pin" => fixture.manifest["editors"][0]["version"] = json!("unknown"),
                    "unlisted-index" => {
                        fixture.manifest["editors"][0]["index"] = json!("missing/index.html")
                    }
                    "purpose" => fixture.manifest["purpose"] = json!("unverified"),
                    _ => unreachable!(),
                }
                config.editor_assets = Some(fixture.persist());
            }
        }
        assert!(EditorAssets::load(&config).await.is_err(), "{case}");
    }
}
#[tokio::test]
#[ignore = "explicit pinned actual read-only ArtCraft bundle; no services"]
async fn actual_official_bundle_passes_the_runtime_inventory_verifier() {
    let fixture = BundleFixture::new();
    let mut config = config(&fixture);
    config.secure_cookies = true;
    config.origin = "https://cloud.example.test".into();
    config.editor_assets = Some(actual_bundle());
    EditorAssets::load(&config).await.unwrap();
}
#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS rolling current/legacy session acceptance"]
async fn rolling_catalogue_preserves_legacy_save_after_restart_and_applies_kill_switch_to_both() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    let old = BundleFixture::new();
    let rolling = rolling_fixture();
    pg.config.storage = Some(fs.config.clone());
    pg.config.editor_assets = Some(old.persist());
    let mut server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup",json!({"email":"rolling@example.test","name":"Rolling","password":random_token(),"setupToken":pg.config.setup_token}),None).await;
    let cookie = setup.credential();
    server
        .state
        .db
        .execute_raw(sql("UPDATE hyori_editor_assets SET enabled=true", vec![]))
        .await
        .unwrap();
    let bytes = b"%PDF-1.7\n%%EOF\n";
    let upload = server.rpc("uploads.begin",json!({"parentId":null,"name":"rolling.pdf","size":bytes.len(),"mimeType":"application/pdf"}),Some(&cookie)).await.value()["uploadId"].as_str().unwrap().to_owned();
    let put = |server: &TestServer, id: &str| {
        server
            .client
            .put(format!("{}/api/storage/uploads/{id}/1", server.url))
            .header("host", "localhost:3001")
            .header("origin", "http://localhost:3001")
            .header("cookie", &cookie)
            .body(bytes.to_vec())
    };
    assert_eq!(put(&server, &upload).send().await.unwrap().status(), 200);
    let file = server
        .rpc(
            "uploads.complete",
            json!({"uploadId":upload}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let legacy = server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .value()
        .clone();
    assert_eq!(legacy["version"], "0.17.0");
    pg.config.editor_assets = Some(rolling.persist());
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    // Synthetic catalogues never autoactivate; this isolated fixture explicitly selects current.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET version='0.17.0-hyori-host.1' WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    let current = server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .value()
        .clone();
    assert_eq!(current["bridge"], "hyori-correlated-host-v2");
    assert_eq!(current["protocol"], 2);
    let request = json!({"sessionId":legacy["sessionId"],"saveId":"legacy:after-upgrade","expectedRevision":legacy["revision"],"name":"rolling.pdf","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes)),"intent":"replace"});
    let prepared = server
        .rpc("editors.prepareSave", request.clone(), Some(&cookie))
        .await
        .value()["uploadId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(put(&server, &prepared).send().await.unwrap().status(), 200);
    server
        .rpc(
            "editors.completeSave",
            json!({"sessionId":legacy["sessionId"],"saveId":"legacy:after-upgrade"}),
            Some(&cookie),
        )
        .await
        .value();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET enabled=false WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    for document in [&legacy, &current] {
        server
            .rpc(
                "editors.download",
                json!({"sessionId":document["sessionId"],"expectedRevision":document["revision"]}),
                Some(&cookie),
            )
            .await
            .error(503, "service.unavailable");
    }
    server
        .rpc("editors.prepareSave", request, Some(&cookie))
        .await
        .error(503, "service.unavailable");
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    assert_eq!(
        server
            .rpc("editors.available", json!({}), None)
            .await
            .value()["apps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|app| app["app"] == "pdfcraft")
            .count(),
        0
    );
    pg.stop();
}
/// The bundle's current editor entries, read from the manifest the pinned hash names.
fn actual_bundle_current_editors() -> Vec<serde_json::Value> {
    let config = actual_bundle();
    let bytes = std::fs::read(config.directory.join("runtime-bundle-manifest.json")).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&bytes)), config.manifest_sha256);
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    manifest["editors"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|editor| editor.get("role").is_none_or(|role| role == "current"))
        .cloned()
        .collect()
}
fn actual_bundle() -> EditorAssetsConfig {
    EditorAssetsConfig {
        directory: std::env::var_os("HYORI_EDITOR_TEST_BUNDLE_DIR")
            .expect("provide explicit verified fixture bundle")
            .into(),
        manifest_sha256: std::env::var("HYORI_EDITOR_TEST_BUNDLE_SHA256")
            .expect("provide explicit manifest hash"),
    }
}
#[tokio::test]
#[ignore = "disposable PostgreSQL/RustFS and explicit pinned actual official ArtCraft bundle"]
async fn actual_bundle_activation_preserves_disable_and_absence_revokes_session_capability() {
    let mut pg = Postgres::start().await;
    let fs = storage::RustFs::start().await;
    pg.config.storage = Some(fs.config.clone());
    pg.config.editor_assets = Some(actual_bundle());
    let mut server = TestServer::start(pg.config.clone()).await;
    let setup=server.rpc("auth.setup",json!({"email":"assets@example.test","name":"Assets","password":random_token(),"setupToken":pg.config.setup_token}),None).await;
    assert!(setup.cookie.is_some());
    let cookie = setup.credential();
    // Expectations come from the bundle itself, so any verified runtime bundle can run this.
    let current = actual_bundle_current_editors();
    let rows=server.state.db.query_all_raw(sql("SELECT app,enabled,first_activated_catalog_sha256 FROM hyori_editor_assets ORDER BY app",vec![])).await.unwrap();
    for row in rows {
        let app: String = row.try_get("", "app").unwrap();
        let shipped = current.iter().any(|editor| editor["app"] == app.as_str());
        assert_eq!(row.try_get::<bool>("", "enabled").unwrap(), shipped);
        assert_eq!(
            row.try_get::<Option<String>>("", "first_activated_catalog_sha256")
                .unwrap()
                .is_some(),
            shipped
        );
    }
    let available = server
        .rpc("editors.available", json!({}), None)
        .await
        .value()
        .clone();
    let expected: Vec<_> = [
        ("wordcraft", vec![".docx"]),
        ("gridcraft", vec![".xlsx"]),
        ("deckcraft", vec![".deckcraft", ".pptx"]),
        ("pdfcraft", vec![".pdf"]),
    ]
    .into_iter()
    .filter_map(|(app, extensions)| {
        let editor = current.iter().find(|editor| editor["app"] == app)?;
        Some(json!({"app":app,"version":editor["version"],"inputExtensions":extensions}))
    })
    .collect();
    assert_eq!(available, json!({ "apps": expected }));
    let pdf = current
        .iter()
        .find(|editor| editor["app"] == "pdfcraft")
        .expect("the bundle ships PdfCraft");
    let bytes = b"%PDF-1.7\n%%EOF\n";
    let begin=server.rpc("uploads.begin",json!({"parentId":null,"name":"runtime.pdf","size":bytes.len(),"mimeType":"application/pdf"}),Some(&cookie)).await;
    let upload = begin.value()["uploadId"].as_str().unwrap();
    assert_eq!(
        server
            .client
            .put(format!("{}/api/storage/uploads/{upload}/1", server.url))
            .header("origin", &pg.config.origin)
            .header("host", "localhost:3001")
            .header("cookie", &cookie)
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let file = server
        .rpc(
            "uploads.complete",
            json!({"uploadId":upload}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let document = server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .value()
        .clone();
    assert_eq!(document["assetUrl"], pdf["assetUrl"]);
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET enabled=false,first_activated_catalog_sha256=repeat('b',64) WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    drop(server);
    server = TestServer::start(pg.config.clone()).await;
    let available = server
        .rpc("editors.available", json!({}), None)
        .await
        .value()
        .clone();
    assert_eq!(
        available["apps"].as_array().unwrap().len(),
        expected.len() - 1
    );
    server
        .rpc(
            "editors.download",
            json!({"sessionId":document["sessionId"],"expectedRevision":document["revision"]}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_editor_assets SET enabled=true WHERE app='pdfcraft'",
            vec![],
        ))
        .await
        .unwrap();
    let mut no_assets = pg.config.clone();
    no_assets.editor_assets = None;
    drop(server);
    server = TestServer::start(no_assets).await;
    assert_eq!(
        server
            .rpc("editors.available", json!({}), None)
            .await
            .value(),
        &json!({"apps":[]})
    );
    server
        .rpc("editors.open", json!({"id":file["id"]}), Some(&cookie))
        .await
        .error(503, "service.unavailable");
    server
        .rpc(
            "editors.download",
            json!({"sessionId":document["sessionId"],"expectedRevision":document["revision"]}),
            Some(&cookie),
        )
        .await
        .error(503, "service.unavailable");
    pg.stop();
}

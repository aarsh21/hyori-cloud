//! Tiny non-vendor assets for persistence tests; never a renderer or deployable editor fixture.
use hyori_server::{auth::random_token, config::EditorAssetsConfig};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

pub struct BundleFixture {
    pub root: PathBuf,
    pub manifest: Value,
}
impl BundleFixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hyori-editor-catalogue-{}", random_token()));
        fs::create_dir(&root).unwrap();
        let mut assets = vec![];
        let mut editors = vec![];
        for (app, version) in [
            ("wordcraft", "0.14.0"),
            ("gridcraft", "0.15.0"),
            ("deckcraft", "0.14.1-hyori-host.2"),
            ("pdfcraft", "0.17.0"),
        ] {
            let path = format!("{app}/{version}/index.html");
            let bytes =
                b"<!doctype html><title>Non-vendor persistence fixture; no editor runtime</title>";
            write(&root.join(&path), bytes);
            let record = json!({"path":path,"bytes":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))});
            let mut asset = record.clone();
            asset["contentType"] = json!("text/html; charset=utf-8");
            asset["cacheControl"] = json!("no-store");
            assets.push(asset);
            editors.push(json!({"app":app,"version":version,"archiveSha256":"0".repeat(64),"index":path,"assetUrl":format!("/artcraft/{app}/{version}/index.html?host=parent"),"bridge":if app=="deckcraft" {"hyori-correlated-host-v1"} else {"upstream-host-parent"},"deployable":true,"files":[record]}));
        }
        let notice =
            b"Synthetic non-vendor fixture. No executable editor assets or legal clearance.\n";
        write(&root.join("legal/RUNTIME-NOTICE-INDEX.md"), notice);
        assets.push(json!({"path":"legal/RUNTIME-NOTICE-INDEX.md","bytes":notice.len(),"sha256":hex::encode(Sha256::digest(notice)),"contentType":"text/plain; charset=utf-8","cacheControl":"no-store"}));
        let fixture = Self {
            root,
            manifest: json!({"schemaVersion":1,"kind":"artcraft-runtime-static-bundle","purpose":"synthetic-persistence-test","mountPath":"/artcraft","deploymentScope":"verified-static-assets-only-not-product-launch-or-legal-clearance","deployable":true,"legalOpinion":false,"productIntegrationVerified":false,"allFourLaunchReady":false,"editors":editors,"assets":assets}),
        };
        fixture.persist();
        fixture
    }
    pub fn persist(&self) -> EditorAssetsConfig {
        modes(&self.root, true);
        let bytes = serde_json::to_vec_pretty(&self.manifest).unwrap();
        fs::write(self.root.join("runtime-bundle-manifest.json"), &bytes).unwrap();
        modes(&self.root, false);
        EditorAssetsConfig {
            directory: self.root.clone(),
            manifest_sha256: hex::encode(Sha256::digest(bytes)),
        }
    }
}
impl Drop for BundleFixture {
    fn drop(&mut self) {
        modes(&self.root, true);
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn modes(path: &Path, writable: bool) {
    let meta = fs::symlink_metadata(path).unwrap();
    if meta.file_type().is_symlink() {
        return;
    }
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if meta.is_dir() {
            if writable { 0o755 } else { 0o555 }
        } else if writable {
            0o644
        } else {
            0o444
        }),
    )
    .unwrap();
    if meta.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            modes(&entry.unwrap().path(), writable);
        }
    }
}

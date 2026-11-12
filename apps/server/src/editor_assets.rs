//! App-owned, read-only editor asset capability. A pinned inventory is not a legal opinion.
use crate::{
    config::Config,
    db::{self, sql},
    error::ApiError,
    features::editors::{api::EditorApp, formats},
};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Component, Path},
};

const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_ENTRY: u64 = 128 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const MANIFEST: &str = "runtime-bundle-manifest.json";
const PREFIX: &str = "/artcraft";

#[derive(Clone, Debug)]
pub struct AssetCapability {
    pub version: String,
    pub asset_url: String,
    pub bridge: String,
    pub protocol: Option<u8>,
}
#[derive(Clone, Default)]
pub struct EditorAssets {
    entries: BTreeMap<(String, String), AssetCapability>,
    current: BTreeMap<String, String>,
    manifest_sha256: String,
    synthetic: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    schema_version: u32,
    kind: String,
    #[serde(default = "runtime_purpose")]
    purpose: String,
    mount_path: String,
    deployment_scope: String,
    deployable: bool,
    legal_opinion: bool,
    product_integration_verified: bool,
    all_four_launch_ready: bool,
    editors: Vec<Editor>,
    assets: Vec<Asset>,
    transport_sidecars: Option<Vec<TransportSidecar>>,
}
#[derive(Deserialize)]
struct TransportSidecar {
    #[serde(flatten)]
    file: InventoryFile,
    encoding: String,
    encoder: String,
    original: InventoryFile,
}
fn runtime_purpose() -> String {
    "runtime".into()
}
#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CatalogueRole {
    Current,
    Legacy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Editor {
    app: EditorApp,
    role: Option<CatalogueRole>,
    protocol: Option<u8>,
    version: String,
    archive_sha256: Option<String>,
    source_archive_sha256: Option<String>,
    build_manifest_sha256: Option<String>,
    payload_sha256: Option<String>,
    index: String,
    asset_url: String,
    bridge: String,
    deployable: bool,
    files: Vec<InventoryFile>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    #[serde(flatten)]
    file: InventoryFile,
    content_type: String,
    cache_control: String,
}
#[derive(Deserialize, serde::Serialize)]
struct InventoryFile {
    path: String,
    bytes: u64,
    sha256: String,
}

impl EditorAssets {
    pub async fn load(config: &Config) -> Result<Self, ApiError> {
        config.validate().map_err(|_| ApiError::unavailable())?;
        let Some(settings) = config.editor_assets.clone() else {
            return Ok(Self::default());
        };
        let synthetic_allowed = !config.secure_cookies && config.bind.ip().is_loopback();
        let assets =
            tokio::task::spawn_blocking(move || Self::verify(&settings, synthetic_allowed))
                .await
                .map_err(|_| ApiError::unavailable())??;
        // Tell the operator before a person meets it: the web client sandboxes every editor frame,
        // and only protocol 3 runs there. Older runtimes stay verified so nothing else breaks.
        for (app, version) in &assets.current {
            if let Some(capability) = assets.entries.get(&(app.clone(), version.clone()))
                && capability.protocol != Some(3)
            {
                tracing::warn!(
                    app = %app,
                    version = %version,
                    "Editor runtime predates sandboxed editor frames; it won't open until the editor bundle is rebuilt"
                );
            }
        }
        Ok(assets)
    }
    fn verify(
        settings: &crate::config::EditorAssetsConfig,
        synthetic_allowed: bool,
    ) -> Result<Self, ApiError> {
        let root = &settings.directory;
        readonly_path(root, true)?;
        if fs::canonicalize(root).map_err(|_| ApiError::unavailable())? != *root {
            return Err(ApiError::unavailable());
        }
        let manifest_path = root.join(MANIFEST);
        readonly_path(&manifest_path, false)?;
        let bytes = bounded_read(&manifest_path, MAX_MANIFEST)?;
        if hex::encode(Sha256::digest(&bytes)) != settings.manifest_sha256 {
            return Err(ApiError::unavailable());
        }
        let bundle: Bundle = serde_json::from_slice(&bytes).map_err(|_| ApiError::unavailable())?;
        let synthetic = bundle.purpose == "synthetic-persistence-test";
        let sidecars = bundle.transport_sidecars.as_deref().unwrap_or(&[]);
        if !matches!(bundle.schema_version, 1 | 2)
            || (bundle.schema_version == 1
                && (bundle.editors.len() > 4 || bundle.transport_sidecars.is_some()))
            || bundle.kind != "artcraft-runtime-static-bundle"
            || bundle.mount_path != PREFIX
            || bundle.deployment_scope
                != "verified-static-assets-only-not-product-launch-or-legal-clearance"
            || !bundle.deployable
            || bundle.legal_opinion
            || bundle.product_integration_verified
            || bundle.all_four_launch_ready
            || (!synthetic && bundle.purpose != "runtime")
            || (synthetic && !synthetic_allowed)
            || bundle.editors.is_empty()
            || bundle.editors.len() > 8
            || bundle.assets.is_empty()
            || bundle.assets.len() > MAX_FILES
            || sidecars.len() > MAX_FILES
        {
            return Err(ApiError::unavailable());
        }
        let mut inventory = BTreeMap::new();
        let mut total = 0_u64;
        for asset in &bundle.assets {
            validate_relative(&asset.file.path)?;
            if asset.file.path == MANIFEST
                || asset.file.bytes > MAX_ENTRY
                || !sha256(&asset.file.sha256)
                || asset.content_type.is_empty()
                || asset.content_type.len() > 128
                || !asset.content_type.is_ascii()
                || asset.content_type.bytes().any(|b| b.is_ascii_control())
                || asset.cache_control.len() > 128
                || !asset.cache_control.is_ascii()
                || asset.cache_control.bytes().any(|b| b.is_ascii_control())
                || inventory
                    .insert(asset.file.path.as_str(), &asset.file)
                    .is_some()
            {
                return Err(ApiError::unavailable());
            }
            total = total
                .checked_add(asset.file.bytes)
                .ok_or_else(ApiError::unavailable)?;
            if total > MAX_TOTAL {
                return Err(ApiError::unavailable());
            }
        }
        if !inventory.contains_key("legal/RUNTIME-NOTICE-INDEX.md") {
            return Err(ApiError::unavailable());
        }
        let mut found = BTreeSet::new();
        scan(root, root, &mut found, 0, &mut 0)?;
        let expected: BTreeSet<_> = inventory
            .keys()
            .map(|path| (*path).to_owned())
            .chain([MANIFEST.to_owned()])
            .collect();
        if found != expected {
            return Err(ApiError::unavailable());
        }
        for file in inventory.values() {
            verify_file(root, file)?;
        }
        let encoded_paths: BTreeSet<_> = sidecars
            .iter()
            .map(|sidecar| sidecar.file.path.as_str())
            .collect();
        if encoded_paths.len() != sidecars.len() {
            return Err(ApiError::unavailable());
        }
        let mut raw_payload = BTreeSet::new();
        let mut entries = BTreeMap::new();
        let mut current = BTreeMap::new();
        let mut legacy = BTreeSet::new();
        for editor in bundle.editors {
            let name = formats::app_name(&editor.app);
            let prefix = format!("{name}/{}/", editor.version);
            let protocol = editor_protocol(&editor)?;
            if (bundle.schema_version == 1 && (editor.role.is_some() || is_native(protocol)))
                || (bundle.schema_version == 2 && editor.role.is_none())
            {
                return Err(ApiError::unavailable());
            }
            if !editor.deployable
                || editor.index != format!("{prefix}index.html")
                || editor.asset_url != format!("{PREFIX}/{}?host=parent", editor.index)
                || editor.files.is_empty()
                || editor.files.len() > MAX_FILES
                || !inventory.contains_key(editor.index.as_str())
                || (!synthetic && !known_identity(&editor, &inventory)?)
            {
                return Err(ApiError::unavailable());
            }
            let mut covered = BTreeSet::new();
            for file in &editor.files {
                let global = inventory
                    .get(file.path.as_str())
                    .ok_or_else(ApiError::unavailable)?;
                if !file.path.starts_with(&prefix)
                    || global.bytes != file.bytes
                    || global.sha256 != file.sha256
                    || encoded_paths.contains(file.path.as_str())
                    || !covered.insert(file.path.as_str())
                {
                    return Err(ApiError::unavailable());
                }
            }
            if !covered.contains(editor.index.as_str())
                || inventory
                    .keys()
                    .filter(|path| path.starts_with(&prefix) && !encoded_paths.contains(**path))
                    .any(|path| !covered.contains(path))
            {
                return Err(ApiError::unavailable());
            }
            raw_payload.extend(covered.into_iter().map(str::to_owned));
            match editor.role.unwrap_or(CatalogueRole::Current) {
                CatalogueRole::Current => {
                    if current
                        .insert(name.to_owned(), editor.version.clone())
                        .is_some()
                    {
                        return Err(ApiError::unavailable());
                    }
                }
                CatalogueRole::Legacy => {
                    if !legacy.insert(name.to_owned()) {
                        return Err(ApiError::unavailable());
                    }
                }
            }
            if entries
                .insert(
                    (name.to_owned(), editor.version.clone()),
                    AssetCapability {
                        version: editor.version,
                        asset_url: editor.asset_url,
                        bridge: editor.bridge,
                        protocol,
                    },
                )
                .is_some()
            {
                return Err(ApiError::unavailable());
            }
        }
        if legacy.iter().any(|app| !current.contains_key(app)) {
            return Err(ApiError::unavailable());
        }
        for sidecar in sidecars {
            verify_sidecar(root, sidecar, &inventory, &raw_payload)?;
        }
        // Unregistered executable payloads must not be served next to otherwise verified editors.
        if inventory.keys().any(|path| {
            !path.starts_with("legal/")
                && !entries
                    .keys()
                    .any(|(app, version)| path.starts_with(&format!("{app}/{version}/")))
        }) {
            return Err(ApiError::unavailable());
        }
        Ok(Self {
            entries,
            current,
            manifest_sha256: settings.manifest_sha256.clone(),
            synthetic,
        })
    }
    pub(crate) fn capability(&self, app: &EditorApp) -> Result<&AssetCapability, ApiError> {
        let version = self
            .current
            .get(formats::app_name(app))
            .ok_or_else(ApiError::unavailable)?;
        self.version_capability(app, version)
    }
    pub(crate) fn version_capability(
        &self,
        app: &EditorApp,
        version: &str,
    ) -> Result<&AssetCapability, ApiError> {
        self.entries
            .get(&(formats::app_name(app).to_owned(), version.to_owned()))
            .ok_or_else(ApiError::unavailable)
    }
    pub(crate) async fn activate(&self, connection: &DatabaseConnection) -> Result<(), ApiError> {
        if self.synthetic || self.entries.is_empty() {
            return Ok(());
        }
        db::domain(connection, |tx| {
            let catalogue = self.clone();
            Box::pin(async move {
                for (app, version) in &catalogue.current {
                    tx.execute_raw(sql("UPDATE hyori_editor_assets SET version=$2, enabled=CASE WHEN first_activated_catalog_sha256 IS NULL THEN true ELSE enabled END, first_activated_catalog_sha256=COALESCE(first_activated_catalog_sha256,$3) WHERE app=$1", vec![app.clone().into(),version.clone().into(),catalogue.manifest_sha256.clone().into()])).await?;
                }
                Ok(())
            })
        }).await
    }
}
fn verify_sidecar(
    root: &Path,
    sidecar: &TransportSidecar,
    inventory: &BTreeMap<&str, &InventoryFile>,
    raw_payload: &BTreeSet<String>,
) -> Result<(), ApiError> {
    if sidecar.encoding != "gzip"
        || sidecar.encoder != "gzip-level6-mtime0-os255-v1"
        || sidecar.file.path != format!("{}.gz", sidecar.original.path)
        || !raw_payload.contains(&sidecar.original.path)
        || !matches!(
            Path::new(&sidecar.original.path)
                .extension()
                .and_then(|value| value.to_str()),
            Some("js" | "wasm")
        )
    {
        return Err(ApiError::unavailable());
    }
    for record in [&sidecar.file, &sidecar.original] {
        let actual = inventory
            .get(record.path.as_str())
            .ok_or_else(ApiError::unavailable)?;
        if actual.bytes != record.bytes || actual.sha256 != record.sha256 {
            return Err(ApiError::unavailable());
        }
    }
    let mut encoded = BufReader::new(
        File::open(root.join(&sidecar.file.path)).map_err(|_| ApiError::unavailable())?,
    );
    if encoded
        .fill_buf()
        .map_err(|_| ApiError::unavailable())?
        .get(..10)
        != Some(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])
    {
        return Err(ApiError::unavailable());
    }
    let mut decoder = flate2::bufread::GzDecoder::new(encoded);
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = decoder
            .read(&mut buffer)
            .map_err(|_| ApiError::unavailable())?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(ApiError::unavailable)?;
        if total > sidecar.original.bytes || total > MAX_ENTRY {
            return Err(ApiError::unavailable());
        }
        hash.update(&buffer[..count]);
    }
    // bufread::GzDecoder stops after exactly one member and leaves even an empty appended member.
    if !decoder
        .into_inner()
        .fill_buf()
        .map_err(|_| ApiError::unavailable())?
        .is_empty()
        || total != sidecar.original.bytes
        || hex::encode(hash.finalize()) != sidecar.original.sha256
    {
        return Err(ApiError::unavailable());
    }
    Ok(())
}
fn editor_protocol(editor: &Editor) -> Result<Option<u8>, ApiError> {
    let native = native_authorities()?.into_iter().find(|(authority, _)| {
        authority.bridge == editor.bridge
            && Some(authority.protocol) == editor.protocol
            && authority
                .apps
                .iter()
                .any(|entry| entry.app == editor.app && entry.artifact_version == editor.version)
    });
    if let Some((authority, _)) = native {
        return Ok(Some(authority.protocol));
    }
    let protocol = if editor.app == EditorApp::Deckcraft {
        Some(1)
    } else {
        None
    };
    let bridge = if editor.app == EditorApp::Deckcraft {
        "hyori-correlated-host-v1"
    } else {
        "upstream-host-parent"
    };
    if editor.version != formats::version(&editor.app)
        || editor.bridge != bridge
        || (editor.protocol.is_some() && editor.protocol != protocol)
    {
        return Err(ApiError::unavailable());
    }
    Ok(protocol)
}
/// Native host protocols: 2 needs a same-origin frame; 3 is the first that runs sandboxed.
fn is_native(protocol: Option<u8>) -> bool {
    matches!(protocol, Some(2 | 3))
}
fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn known_identity(
    editor: &Editor,
    inventory: &BTreeMap<&str, &InventoryFile>,
) -> Result<bool, ApiError> {
    known_identity_with_pins(
        editor,
        inventory,
        include_str!("../../../tooling/artcraft/manifest.json"),
    )
}
fn known_identity_with_pins(
    editor: &Editor,
    inventory: &BTreeMap<&str, &InventoryFile>,
    pins: &str,
) -> Result<bool, ApiError> {
    #[derive(Deserialize)]
    struct Pins {
        editors: Vec<Pin>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Pin {
        app: String,
        sha256: String,
        source_sha256: String,
    }
    let pins: Pins = serde_json::from_str(pins).map_err(|_| ApiError::unavailable())?;
    if is_native(editor.protocol) {
        return known_native_identity(editor, inventory);
    }
    if editor.app == EditorApp::Deckcraft {
        let source_pin = pins
            .editors
            .iter()
            .find(|pin| pin.app == "deckcraft")
            .ok_or_else(ApiError::unavailable)?;
        return known_deck_identity(editor, inventory, &source_pin.source_sha256);
    }
    Ok(editor.version == formats::version(&editor.app)
        && editor.source_archive_sha256.is_none()
        && editor.build_manifest_sha256.is_none()
        && editor.payload_sha256.is_none()
        && pins.editors.iter().any(|pin| {
            pin.app == formats::app_name(&editor.app)
                && Some(pin.sha256.as_str()) == editor.archive_sha256.as_deref()
        }))
}
fn known_deck_identity(
    editor: &Editor,
    inventory: &BTreeMap<&str, &InventoryFile>,
    source_pin: &str,
) -> Result<bool, ApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Authority {
        schema_version: u32,
        artifact_version: String,
        source_archive_sha256: String,
        build_manifest_sha256: String,
        payload_sha256: String,
        receipt_sha256: String,
        source_summary_sha256: String,
        receipt_root: String,
        source_summary: String,
    }
    const AUTHORITY: &str = include_str!("../../../tooling/artcraft/runtime-deckcraft-v2.json");
    let authority: Authority =
        serde_json::from_str(AUTHORITY).map_err(|_| ApiError::unavailable())?;
    validate_relative(&authority.receipt_root)?;
    if authority.schema_version != 1
        || authority.artifact_version != formats::version(&EditorApp::Deckcraft)
        || editor.version != authority.artifact_version
        || editor.archive_sha256.is_some()
        || authority.source_archive_sha256 != source_pin
        || editor.source_archive_sha256.as_deref() != Some(authority.source_archive_sha256.as_str())
        || editor.build_manifest_sha256.as_deref() != Some(authority.build_manifest_sha256.as_str())
        || editor.payload_sha256.as_deref() != Some(authority.payload_sha256.as_str())
        || authority.source_summary != format!("{}/source-summary.json", authority.receipt_root)
    {
        return Ok(false);
    }
    if payload_sha256(&editor.files)?.as_deref() != Some(authority.payload_sha256.as_str()) {
        return Ok(false);
    }
    let authority_hash = hex::encode(Sha256::digest(AUTHORITY.as_bytes()));
    for (name, expected) in [
        (
            "build-manifest.json",
            authority.build_manifest_sha256.as_str(),
        ),
        ("receipt.json", authority.receipt_sha256.as_str()),
        (
            "source-summary.json",
            authority.source_summary_sha256.as_str(),
        ),
        ("authority.json", authority_hash.as_str()),
    ] {
        if !sha256(expected)
            || !inventory
                .get(format!("legal/deckcraft-host-v2/{name}").as_str())
                .is_some_and(|file| file.sha256 == expected)
        {
            return Ok(false);
        }
    }
    Ok(true)
}
/// The producer's canonical payload identity: compact UTF-8 JSON with ordered keys and ASCII
/// byte-lexical paths. `None` when a path repeats, which no producer emits.
fn payload_sha256(files: &[InventoryFile]) -> Result<Option<String>, ApiError> {
    let mut files: Vec<_> = files.iter().collect();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if files.windows(2).any(|pair| pair[0].path == pair[1].path) {
        return Ok(None);
    }
    let json = serde_json::to_vec(&files).map_err(|_| ApiError::unavailable())?;
    Ok(Some(hex::encode(Sha256::digest(json))))
}
// Every committed native host v3 authority revision, oldest first. A revision is never rewritten,
// so bundles it identifies keep verifying; each bundle carries exactly one of them.
include!(concat!(env!("OUT_DIR"), "/native_authorities.rs"));
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAuthority {
    schema_version: u32,
    bridge: String,
    protocol: u8,
    receipt_root: String,
    apps: Vec<NativeAppAuthority>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAppAuthority {
    app: EditorApp,
    artifact_version: String,
    source_archive_sha256: String,
    build_manifest_sha256: String,
    payload_sha256: String,
    receipt_sha256: String,
    source_summary_sha256: String,
    wasm_sha256: String,
}
/// Each compiled-in authority with the SHA-256 of its exact committed bytes.
fn native_authorities() -> Result<Vec<(NativeAuthority, String)>, ApiError> {
    NATIVE_AUTHORITIES
        .iter()
        .map(|bytes| {
            let authority: NativeAuthority =
                serde_json::from_str(bytes).map_err(|_| ApiError::unavailable())?;
            validate_relative(&authority.receipt_root)?;
            Ok((authority, hex::encode(Sha256::digest(bytes.as_bytes()))))
        })
        .collect()
}
/// Native host v3 builds: the authority revision the bundle carries pins each app's build,
/// payload, receipt and source summary; the bundle must carry those exact receipts too.
fn known_native_identity(
    editor: &Editor,
    inventory: &BTreeMap<&str, &InventoryFile>,
) -> Result<bool, ApiError> {
    let Some(carried) = inventory.get("legal/native-host-v3/authority.json") else {
        return Ok(false);
    };
    let authorities = native_authorities()?;
    let Some((authority, authority_hash)) =
        authorities.iter().find(|(_, hash)| *hash == carried.sha256)
    else {
        return Ok(false);
    };
    let Some(entry) = authority.apps.iter().find(|entry| entry.app == editor.app) else {
        return Ok(false);
    };
    let name = formats::app_name(&editor.app);
    if authority.schema_version != 1
        || authority.bridge != editor.bridge
        || Some(authority.protocol) != editor.protocol
        || entry.artifact_version != editor.version
        || editor.archive_sha256.is_some()
        || editor.source_archive_sha256.as_deref() != Some(entry.source_archive_sha256.as_str())
        || editor.build_manifest_sha256.as_deref() != Some(entry.build_manifest_sha256.as_str())
        || editor.payload_sha256.as_deref() != Some(entry.payload_sha256.as_str())
        || !sha256(&entry.wasm_sha256)
        || !editor
            .files
            .iter()
            .any(|file| file.path.ends_with("_bg.wasm") && file.sha256 == entry.wasm_sha256)
        || payload_sha256(&editor.files)?.as_deref() != Some(entry.payload_sha256.as_str())
    {
        return Ok(false);
    }
    for (path, expected) in [
        (
            format!("legal/native-host-v3/{name}/build-manifest.json"),
            entry.build_manifest_sha256.as_str(),
        ),
        (
            format!("legal/native-host-v3/{name}/receipt.json"),
            entry.receipt_sha256.as_str(),
        ),
        (
            format!("legal/native-host-v3/{name}/source-summary.json"),
            entry.source_summary_sha256.as_str(),
        ),
        (
            "legal/native-host-v3/authority.json".to_owned(),
            authority_hash.as_str(),
        ),
    ] {
        if !sha256(expected)
            || !inventory
                .get(path.as_str())
                .is_some_and(|file| file.sha256 == expected)
        {
            return Ok(false);
        }
    }
    Ok(true)
}
fn validate_relative(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > 1024
        || !value.is_ascii()
        || value.contains(['\\', '%', '?', '#', ':'])
        || value.bytes().any(|b| b.is_ascii_control())
        || value.starts_with('/')
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | "..") || part.len() > 255)
    {
        return Err(ApiError::unavailable());
    }
    Ok(())
}
fn readonly_path(path: &Path, directory: bool) -> Result<(), ApiError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ApiError::unavailable())?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
        || !metadata.permissions().readonly()
    {
        return Err(ApiError::unavailable());
    }
    Ok(())
}
fn scan(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
    depth: usize,
    visited: &mut usize,
) -> Result<(), ApiError> {
    if depth > 16 {
        return Err(ApiError::unavailable());
    }
    for entry in fs::read_dir(directory).map_err(|_| ApiError::unavailable())? {
        *visited += 1;
        if *visited > MAX_FILES * 2 {
            return Err(ApiError::unavailable());
        }
        let entry = entry.map_err(|_| ApiError::unavailable())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| ApiError::unavailable())?;
        if metadata.is_dir() {
            readonly_path(&entry.path(), true)?;
            scan(root, &entry.path(), files, depth + 1, visited)?;
        } else {
            readonly_path(&entry.path(), false)?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ApiError::unavailable())?
                .to_str()
                .ok_or_else(ApiError::unavailable)?;
            validate_relative(relative)?;
            if !files.insert(relative.to_owned()) || files.len() > MAX_FILES + 1 {
                return Err(ApiError::unavailable());
            }
        }
    }
    Ok(())
}
fn bounded_read(path: &Path, max: u64) -> Result<Vec<u8>, ApiError> {
    let mut file = File::open(path).map_err(|_| ApiError::unavailable())?;
    let size = file.metadata().map_err(|_| ApiError::unavailable())?.len();
    if size == 0 || size > max {
        return Err(ApiError::unavailable());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::unavailable())?;
    if bytes.len() as u64 != size {
        return Err(ApiError::unavailable());
    }
    Ok(bytes)
}
fn verify_file(root: &Path, entry: &InventoryFile) -> Result<(), ApiError> {
    let mut path = root.to_path_buf();
    let components: Vec<_> = Path::new(&entry.path).components().collect();
    for (index, component) in components.iter().enumerate() {
        if !matches!(component, Component::Normal(_)) {
            return Err(ApiError::unavailable());
        }
        path.push(component);
        readonly_path(&path, index + 1 < components.len())?;
    }
    let mut file = File::open(path).map_err(|_| ApiError::unavailable())?;
    if file.metadata().map_err(|_| ApiError::unavailable())?.len() != entry.bytes {
        return Err(ApiError::unavailable());
    }
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ApiError::unavailable())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > entry.bytes {
            return Err(ApiError::unavailable());
        }
        hash.update(&buffer[..read]);
    }
    if total != entry.bytes || hex::encode(hash.finalize()) != entry.sha256 {
        return Err(ApiError::unavailable());
    }
    Ok(())
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn native_versions_cannot_borrow_the_official_archive_identity() {
        let pins: serde_json::Value =
            serde_json::from_str(include_str!("../../../tooling/artcraft/manifest.json")).unwrap();
        for (authority, _) in native_authorities().unwrap() {
            for entry in authority.apps {
                let app = formats::app_name(&entry.app);
                let pin = pins["editors"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|pin| pin["app"] == app)
                    .unwrap();
                let editor: Editor = serde_json::from_value(serde_json::json!({
                    "app":app,"version":entry.artifact_version,"bridge":"hyori-correlated-host-v2",
                    "protocol":2,"archiveSha256":pin["sha256"],"index":"index.html",
                    "assetUrl":"/artcraft/index.html","deployable":true,"files":[]
                }))
                .unwrap();
                assert_eq!(editor_protocol(&editor).unwrap(), Some(2));
                assert!(!known_identity(&editor, &BTreeMap::new()).unwrap());
            }
        }
    }

    const APPS: [&str; 4] = ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"];

    fn tooling(path: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../tooling/artcraft/{path}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    /// The editor entry and legal inventory a correctly assembled bundle of `revision` carries.
    fn native_bundle(revision: usize, app: &str) -> (Editor, Vec<InventoryFile>) {
        let authority = NATIVE_AUTHORITIES[revision];
        let parsed: NativeAuthority = serde_json::from_str(authority).unwrap();
        let receipts = parsed.receipt_root;
        let receipt: serde_json::Value =
            serde_json::from_slice(&tooling(&format!("{receipts}/{app}/receipt.json"))).unwrap();
        let version = receipt["artifactVersion"].as_str().unwrap();
        let editor: Editor = serde_json::from_value(serde_json::json!({
            "app": app, "role": "current", "protocol": 2, "version": version,
            "bridge": "hyori-correlated-host-v2",
            "sourceArchiveSha256": receipt["sourceArchiveSha256"],
            "buildManifestSha256": receipt["buildManifestSha256"],
            "payloadSha256": receipt["payloadSha256"],
            "index": format!("{app}/{version}/index.html"),
            "assetUrl": format!("/artcraft/{app}/{version}/index.html?host=parent"),
            "deployable": true, "files": receipt["files"],
        }))
        .unwrap();
        let mut legal: Vec<_> = ["build-manifest.json", "receipt.json", "source-summary.json"]
            .into_iter()
            .map(|name| {
                let bytes = tooling(&format!("{receipts}/{app}/{name}"));
                InventoryFile {
                    path: format!("legal/native-host-v3/{app}/{name}"),
                    bytes: bytes.len() as u64,
                    sha256: hex::encode(Sha256::digest(bytes)),
                }
            })
            .collect();
        legal.push(InventoryFile {
            path: "legal/native-host-v3/authority.json".into(),
            bytes: authority.len() as u64,
            sha256: hex::encode(Sha256::digest(authority.as_bytes())),
        });
        (editor, legal)
    }

    fn inventory(files: &[InventoryFile]) -> BTreeMap<&str, &InventoryFile> {
        files
            .iter()
            .map(|file| (file.path.as_str(), file))
            .collect()
    }

    fn revisions() -> std::ops::Range<usize> {
        0..NATIVE_AUTHORITIES.len()
    }

    #[test]
    fn native_builds_are_known_from_every_committed_authority() {
        for revision in revisions() {
            for app in APPS {
                let (editor, legal) = native_bundle(revision, app);
                assert_eq!(editor_protocol(&editor).unwrap(), Some(2), "{app}");
                assert!(
                    known_identity(&editor, &inventory(&legal)).unwrap(),
                    "r{revision} {app}"
                );
            }
        }
    }

    #[test]
    fn native_builds_survive_a_source_pin_upgrade_but_refuse_unknown_sources() {
        let mut pins: serde_json::Value =
            serde_json::from_str(include_str!("../../../tooling/artcraft/manifest.json")).unwrap();
        pins["editors"][0]["sourceSha256"] = serde_json::json!("a".repeat(64));
        let pins = serde_json::to_string(&pins).unwrap();
        for revision in revisions() {
            let (mut editor, legal) = native_bundle(revision, "wordcraft");
            assert!(known_identity_with_pins(&editor, &inventory(&legal), &pins).unwrap());
            editor.source_archive_sha256 = Some("b".repeat(64));
            assert!(!known_identity_with_pins(&editor, &inventory(&legal), &pins).unwrap());
        }
    }

    #[test]
    fn native_identity_rejects_a_changed_payload_file() {
        for revision in revisions() {
            for app in APPS {
                let (mut editor, legal) = native_bundle(revision, app);
                editor.files[0].sha256 = "0".repeat(64);
                assert!(
                    !known_identity(&editor, &inventory(&legal)).unwrap(),
                    "r{revision} {app}"
                );
            }
        }
    }

    #[test]
    fn native_identity_requires_the_bundled_receipts() {
        for revision in revisions() {
            for app in APPS {
                let (editor, legal) = native_bundle(revision, app);
                for missing in 0..legal.len() {
                    let mut partial: Vec<_> = legal.iter().collect();
                    partial.remove(missing);
                    let inventory = partial
                        .into_iter()
                        .map(|file| (file.path.as_str(), file))
                        .collect();
                    assert!(
                        !known_identity(&editor, &inventory).unwrap(),
                        "r{revision} {app}"
                    );
                }
            }
        }
    }

    #[test]
    fn native_identity_is_checked_against_the_carried_revision_only() {
        // An editor from one revision is unknown to a bundle carrying another revision's
        // authority and receipts, even where both revisions name the same version.
        for app in APPS {
            let (editor, _) = native_bundle(1, app);
            let (_, other) = native_bundle(0, app);
            assert!(
                !known_identity(&editor, &inventory(&other)).unwrap(),
                "{app}"
            );
            let (editor, _) = native_bundle(0, app);
            let (_, other) = native_bundle(1, app);
            assert!(
                !known_identity(&editor, &inventory(&other)).unwrap(),
                "{app}"
            );
        }
    }

    #[test]
    fn native_identity_is_not_shared_between_apps() {
        for revision in revisions() {
            let (mut editor, legal) = native_bundle(revision, "wordcraft");
            editor.app = EditorApp::Gridcraft;
            assert!(!known_identity(&editor, &inventory(&legal)).unwrap());
        }
    }
}

use std::path::{Path, PathBuf};
fn sources(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}
#[test]
fn better_auth_is_encapsulated_and_feature_dtos_are_typed() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    for file in files {
        let source = std::fs::read_to_string(&file).unwrap();
        if !file.starts_with(root.join("auth")) {
            assert!(
                !source.contains("better_auth"),
                "vendor escaped owned auth adapter: {}",
                file.display()
            );
        }
        if file.starts_with(root.join("features")) && file.file_name().unwrap() == "api.rs" {
            assert!(
                !source.contains("serde_json::Value"),
                "wire DTO bypass: {}",
                file.display()
            );
        }
        if file.starts_with(root.join("features")) {
            for direct in ["reqwest::", "Database::connect", "std::env::"] {
                assert!(
                    !source.contains(direct),
                    "feature bypassed composition ownership: {}",
                    file.display()
                );
            }
        }
    }
}
#[test]
fn feature_registration_derives_new_contracts_without_a_client_catalog() {
    #[derive(schemars::JsonSchema)]
    struct ProbeInput {
        #[allow(dead_code)]
        id: hyori_server::features::auth::api::Id,
    }
    #[derive(schemars::JsonSchema)]
    struct ProbeOutput {
        #[allow(dead_code)]
        found: bool,
    }
    let mut manifest = hyori_server::wire::manifest().unwrap();
    manifest
        .operation::<ProbeInput, ProbeOutput>("fixture.lookup", "query", &[], false)
        .unwrap();
    let operation = manifest.operations.last().unwrap();
    assert_eq!(operation.input, "ProbeInput");
    assert_eq!(operation.output, "ProbeOutput");
    assert!(manifest.schemas.contains_key("ProbeInput"));
    assert!(manifest.schemas.contains_key("ProbeOutput"));
}

use hyori_server::{
    features::{auth::api::*, files::api::*, photos::api::*, uploads::api::*},
    wire::{decode, manifest},
};
use serde_json::json;
#[test]
fn complete_deterministic_catalog() {
    let manifest = manifest().unwrap();
    assert_eq!(manifest.operations.len(), 68);
    for name in [
        "photos.library",
        "photos.details",
        "notes.list",
        "notes.get",
        "notes.create",
        "notes.rename",
        "notes.favorite",
        "notes.history",
        "notes.checkpoint",
        "notes.restoreCheckpoint",
        "collaboration.open",
        "collaboration.sync",
        "collaboration.close",
    ] {
        assert!(
            manifest
                .operations
                .iter()
                .any(|operation| operation.name == name)
        );
    }
    assert_eq!(
        serde_json::to_string(&manifest).unwrap(),
        serde_json::to_string(&hyori_server::wire::manifest().unwrap()).unwrap()
    );
    for name in [
        "Id",
        "Name",
        "Bytes",
        "Timestamp",
        "Empty",
        "Done",
        "ApiError",
        "User",
        "AuthStatus",
        "Credentials",
        "NewAccount",
        "Setup",
        "AcceptInvite",
        "ShareRole",
        "Access",
        "FileEntry",
        "ItemInput",
        "ListFiles",
        "FileList",
        "CreateFolder",
        "RenameFile",
        "MoveFile",
        "FileVersion",
        "Versions",
        "ListVersions",
        "RestoreVersion",
        "DeleteVersion",
        "PermanentDeletion",
        "TrashSummary",
        "DownloadInput",
        "Download",
        "BeginUpload",
        "UploadInput",
        "UploadPartInput",
        "UploadStatus",
        "UploadPart",
        "AcknowledgedPart",
        "IncomingUploads",
        "PendingUploadsInput",
        "PendingUploads",
        "Share",
        "SharesListInput",
        "SharesList",
        "CreateShare",
        "ShareInput",
        "ResolveShare",
        "UnlockShare",
        "ResolvedShare",
        "AdminUser",
        "UsersList",
        "UsersInput",
        "CreateUser",
        "CreateInvite",
        "Invite",
        "SetQuota",
        "DeleteUser",
        "PurgeResult",
        "PhotoSources",
        "TimelineInput",
        "Timeline",
        "LibraryInput",
        "PhotoLibrary",
        "PhotoDetails",
        "Album",
        "Albums",
        "CreateAlbum",
        "AddToAlbum",
        "Note",
        "NoteListInput",
        "NoteList",
        "CreateNote",
        "RenameNote",
        "FavoriteNote",
        "NoteCheckpoint",
        "NoteHistoryInput",
        "NoteHistory",
        "RestoreNoteCheckpoint",
        "CollaborationOpen",
        "CollaborationDocument",
        "CollaborationSync",
        "CollaborationReceipt",
        "CollaborationClose",
    ] {
        assert!(
            manifest.schemas.contains_key(name),
            "missing exported schema {name}"
        );
    }
    let _registry = hyori_server::rpc::RpcRegistry::new().unwrap();
}
#[test]
fn bounds_nullable_and_optional_are_runtime_enforced() {
    assert!(decode::<Bytes>(json!(9007199254740991_u64)).is_ok());
    for invalid in [
        json!(-1),
        json!(1.2),
        json!(9007199254740992_u64),
        json!("1"),
    ] {
        assert!(decode::<Bytes>(invalid).is_err());
    }
    assert!(decode::<CreateFolder>(json!({"parentId":null,"name":"folder"})).is_ok());
    assert!(decode::<CreateFolder>(json!({"name":"folder"})).is_err());
    assert!(decode::<ListFiles>(json!({})).is_ok());
    assert!(decode::<ListFiles>(json!({"parentId":null})).is_ok());
    assert!(decode::<ListFiles>(json!({"limit":null})).is_err());
    assert!(decode::<ListFiles>(json!({"limit":101})).is_err());
    assert!(decode::<ListFiles>(json!({"after":"not a date"})).is_err());
    assert!(decode::<ListFiles>(json!({"after":"2026-11-05T00:00:00Z"})).is_ok());
    assert!(decode::<Timestamp>(json!("2026-11-05")).is_ok());
    assert!(decode::<Timestamp>(json!("2026-02-30")).is_err());
    assert_eq!(
        Timestamp("2026-11-05".into()).parse().unwrap().to_rfc3339(),
        "2026-11-05T00:00:00+00:00"
    );
    assert!(decode::<Name>(json!("")).is_err());
    assert!(decode::<Id>(json!("../other")).is_err());
    assert!(decode::<UploadPartInput>(json!({"uploadId":"abc","partNumber":10001})).is_err());
    assert!(decode::<PhotoSources>(json!({"allMyFiles":true,"folderIds":vec!["a";101]})).is_err());
    assert!(decode::<Done>(json!({"success":false})).is_err());
    assert!(decode::<Done>(json!({"success":true})).is_ok());
}
#[test]
fn editor_descriptor_protocols_and_legacy_save_fingerprints_are_exact() {
    use hyori_server::features::editors::api::{EditorPrepareSave, EditorProtocol};
    assert!(decode::<EditorProtocol>(json!(1)).is_ok());
    assert!(decode::<EditorProtocol>(json!(2)).is_ok());
    assert!(decode::<EditorProtocol>(json!(3)).is_ok());
    for invalid in [json!(0), json!(4), json!(1.5), json!("2"), json!(null)] {
        assert!(decode::<EditorProtocol>(invalid).is_err());
    }
    let legacy = format!(
        r#"{{"sessionId":"session","saveId":"save:1","expectedRevision":"0","name":"draft.pdf","size":1,"sha256":"{}","intent":"replace"}}"#,
        "0".repeat(64)
    );
    let input: EditorPrepareSave = decode(serde_json::from_str(&legacy).unwrap()).unwrap();
    assert_eq!(serde_json::to_string(&input).unwrap(), legacy);
    let mut automatic = serde_json::to_value(&input).unwrap();
    automatic["saveMode"] = json!("automatic");
    assert!(decode::<EditorPrepareSave>(automatic.clone()).is_ok());
    automatic["saveMode"] = json!(null);
    assert!(decode::<EditorPrepareSave>(automatic).is_err());
}
#[test]
fn production_configuration_and_cookie_policy() {
    use hyori_server::{
        auth::{AuthAdapter, random_token},
        config::Config,
    };
    let mut config = Config {
        database_url: format!(
            "postgres://fixture:{}@127.0.0.1:5432/fixture",
            random_token()
        ),
        origin: "https://cloud.example.test".into(),
        setup_token: random_token(),
        auth_secret: random_token(),
        secure_cookies: true,
        bind: "127.0.0.1:3002".parse().unwrap(),
        default_quota_bytes: 1024,
        trash_retention_days: hyori_server::config::DEFAULT_TRASH_RETENTION_DAYS,
        database_max_connections: hyori_server::config::DEFAULT_DATABASE_CONNECTIONS,
        storage: None,
        media_worker_socket: None,
        editor_assets: None,
        trusted_proxies: vec![],
        sign_in_answer: hyori_server::config::SIGN_IN_ANSWER,
    };
    config.validate().unwrap();
    let adapter = AuthAdapter::new(std::sync::Arc::new(config.clone()));
    let cookie = adapter.cookie(Some(&random_token()));
    for attribute in [
        "; Secure",
        "; HttpOnly",
        "; SameSite=Strict",
        "; Path=/",
        "; Max-Age=604800",
    ] {
        assert!(cookie.contains(attribute));
    }
    assert!(adapter.cookie(None).contains("Max-Age=0; Secure"));
    config.origin = "http://localhost:3001".into();
    assert!(config.validate().is_err());
    config.secure_cookies = false;
    config.validate().unwrap();
    config.origin = "http://cloud.example.test".into();
    assert!(config.validate().is_err());
}
#[test]
fn csrf_requires_origin_and_original_host() {
    use axum::http::HeaderMap;
    let mut headers = HeaderMap::new();
    headers.insert("host", "cloud.example.test".parse().unwrap());
    assert!(hyori_server::rpc::validate_origin(&headers, "https://cloud.example.test").is_err());
    headers.insert("origin", "https://cloud.example.test".parse().unwrap());
    assert!(hyori_server::rpc::validate_origin(&headers, "https://cloud.example.test").is_ok());
    headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert!(hyori_server::rpc::validate_origin(&headers, "https://cloud.example.test").is_err());
}

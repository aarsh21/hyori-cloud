use futures_util::stream;
use hyori_storage::{ObjectStorage, PartRef, StorageConfig, StorageError};

fn config() -> StorageConfig {
    StorageConfig {
        endpoint: "http://127.0.0.1:1".into(),
        region: "us-east-1".into(),
        bucket: "hyori-validation-fixture".into(),
        access_key_id: "test-only-access".into(),
        secret_access_key: "test-only-secret".into(),
    }
}

#[test]
fn explicit_configuration_rejects_ambient_or_unsafe_endpoint_values() {
    for endpoint in [
        "",
        "relative",
        "file:///tmp/data",
        "https://user:secret@example.test",
        "https://example.test/path",
        "https://example.test?query",
        "https://example.test#fragment",
    ] {
        let mut value = config();
        value.endpoint = endpoint.into();
        assert!(matches!(
            ObjectStorage::new(value),
            Err(StorageError::InvalidConfig(_))
        ));
    }
    for bucket in [
        "",
        "a",
        "UPPERCASE",
        "bad/bucket",
        "-leading",
        "trailing-",
        "bucket.name",
    ] {
        let mut value = config();
        value.bucket = bucket.into();
        assert!(matches!(
            ObjectStorage::new(value),
            Err(StorageError::InvalidConfig(_))
        ));
    }
    for region in ["", "us east 1", "us/east", "us-east-1\n"] {
        let mut value = config();
        value.region = region.into();
        assert!(matches!(
            ObjectStorage::new(value),
            Err(StorageError::InvalidConfig(_))
        ));
    }
    for secret in ["", "a b", "secret\nvalue"] {
        let mut value = config();
        value.secret_access_key = secret.into();
        assert!(matches!(
            ObjectStorage::new(value),
            Err(StorageError::InvalidConfig(_))
        ));
        let mut value = config();
        value.access_key_id = secret.into();
        assert!(matches!(
            ObjectStorage::new(value),
            Err(StorageError::InvalidConfig(_))
        ));
    }
}

#[test]
fn configuration_debug_redacts_credentials_and_endpoint() {
    let value = config();
    let debug = format!("{value:?}");
    assert!(!debug.contains(&value.access_key_id));
    assert!(!debug.contains(&value.secret_access_key));
    assert!(!debug.contains(&value.endpoint));
}

#[tokio::test]
async fn private_keys_and_owner_ids_reject_raw_user_paths_before_network_io() {
    let storage = ObjectStorage::new(config()).unwrap();
    for key in [
        "",
        "file.txt",
        "owners/id",
        "owners/id/",
        "owners/id/../other",
        "owners/id/user-name.txt",
        "owners/id/%2f",
        "owners//key",
        "other/id/key",
    ] {
        assert!(matches!(
            storage.begin(key, "text/plain").await,
            Err(StorageError::InvalidInput(_))
        ));
    }
    for owner in ["", "../id", "id/other", "id%2fother", ".", "..", "id?x=1"] {
        assert!(matches!(
            storage.purge_owner_objects(owner).await,
            Err(StorageError::InvalidInput(_))
        ));
    }
}

#[tokio::test]
async fn invalid_single_ranges_are_rejected_before_network_io() {
    let storage = ObjectStorage::new(config()).unwrap();
    for range in [
        "",
        "bytes=",
        "bytes=-",
        "bytes=-0",
        "items=0-1",
        "bytes=3-1",
        "bytes=0-1,3-4",
        "bytes= 0-1",
        "bytes=+1-2",
        "bytes=0-9999999999999999999999",
        "bytes=0-1\r\nX: x",
    ] {
        assert!(matches!(
            storage.read("owners/validation/key", Some(range)).await,
            Err(StorageError::InvalidInput(_))
        ));
    }
}

#[tokio::test]
async fn completion_rejects_empty_duplicate_noncontiguous_or_invalid_part_references() {
    let storage = ObjectStorage::new(config()).unwrap();
    for parts in [
        vec![],
        vec![PartRef {
            part_number: 0,
            etag: "etag".into(),
        }],
        vec![PartRef {
            part_number: 2,
            etag: "etag".into(),
        }],
        vec![PartRef {
            part_number: 1,
            etag: "".into(),
        }],
        vec![PartRef {
            part_number: 1,
            etag: "etag\n".into(),
        }],
        vec![
            PartRef {
                part_number: 1,
                etag: "etag".into(),
            },
            PartRef {
                part_number: 1,
                etag: "etag".into(),
            },
        ],
    ] {
        assert!(matches!(
            storage
                .complete("owners/validation/key", "durable-id", &parts, 0)
                .await,
            Err(StorageError::InvalidInput(_))
        ));
    }
}

#[tokio::test]
async fn upload_id_and_mime_validation_is_fallible_before_network_io() {
    let storage = ObjectStorage::new(config()).unwrap();
    assert!(matches!(
        storage
            .begin("owners/validation/key", "text/plain\r\nX: evil")
            .await,
        Err(StorageError::InvalidInput(_))
    ));
    assert!(matches!(
        storage.abort("owners/validation/key", "").await,
        Err(StorageError::InvalidInput(_))
    ));
    assert!(matches!(
        storage
            .part(
                "owners/validation/key",
                "\n",
                1,
                0,
                Box::pin(stream::empty())
            )
            .await,
        Err(StorageError::InvalidInput(_))
    ));
}

#[test]
fn owned_client_is_clone_send_sync_and_stream_error_is_send_sync() {
    fn assert_client<T: Clone + Send + Sync>() {}
    fn assert_error<T: std::error::Error + Send + Sync>() {}
    assert_client::<ObjectStorage>();
    assert_error::<StorageError>();
}

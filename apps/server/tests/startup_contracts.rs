use hyori_server::{
    features::auth::api::{AuthStatus, Done, Empty},
    rpc::{RpcRegistry, RpcResult},
    wire::{ContractError, Manifest, Nullable, manifest},
};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde_json::json;
use std::borrow::Cow;

#[test]
fn duplicate_operation_returns_a_construction_error() {
    let mut contract = manifest().unwrap();
    let result = contract.operation::<Empty, AuthStatus>("auth.status", "query", &[], false);
    assert!(matches!(
        result,
        Err(ContractError::DuplicateOperation("auth.status"))
    ));
}

#[test]
fn conflicting_named_schemas_return_a_construction_error() {
    struct StringSchema;
    struct BooleanSchema;
    impl JsonSchema for StringSchema {
        fn schema_name() -> Cow<'static, str> {
            "Collision".into()
        }
        fn json_schema(_: &mut SchemaGenerator) -> Schema {
            schemars::json_schema!({ "type": "string" })
        }
    }
    impl JsonSchema for BooleanSchema {
        fn schema_name() -> Cow<'static, str> {
            "Collision".into()
        }
        fn json_schema(_: &mut SchemaGenerator) -> Schema {
            schemars::json_schema!({ "type": "boolean" })
        }
    }
    let mut contract = Manifest::default();
    contract.schema::<StringSchema>().unwrap();
    assert!(
        matches!(contract.schema::<BooleanSchema>(), Err(ContractError::ConflictingSchema(name)) if name == "Collision")
    );
}

#[test]
fn registry_rejects_a_missing_schema_without_panicking() {
    let mut contract = manifest().unwrap();
    contract.schemas.remove("AuthStatus");
    assert!(
        matches!(RpcRegistry::from_manifest(contract), Err(ContractError::MissingSchema(name)) if name == "AuthStatus")
    );
}

#[test]
fn registry_rejects_invalid_validator_definitions_without_panicking() {
    let mut contract = manifest().unwrap();
    contract
        .schemas
        .insert("AuthStatus".into(), json!({ "type": "not-a-json-type" }));
    assert!(matches!(
        RpcRegistry::from_manifest(contract),
        Err(ContractError::InvalidValidator(_))
    ));
}

#[test]
fn registry_rejects_non_object_schemas_without_panicking() {
    let mut contract = manifest().unwrap();
    contract.schemas.insert("AuthStatus".into(), json!(false));
    assert!(
        matches!(RpcRegistry::from_manifest(contract), Err(ContractError::InvalidSchema(name)) if name == "AuthStatus")
    );
}

#[test]
fn undeclared_handler_returns_a_binding_error() {
    let mut registry = RpcRegistry::new().unwrap();
    let result = registry.bind::<Empty, Done, _, _>("missing.operation", |_, _, _| async {
        Ok(RpcResult::value(Done { success: true }))
    });
    assert!(matches!(
        result,
        Err(ContractError::UndeclaredHandler("missing.operation"))
    ));
}

#[test]
fn mismatched_handler_returns_a_binding_error() {
    let mut registry = RpcRegistry::new().unwrap();
    let result = registry.bind::<Empty, Done, _, _>("auth.status", |_, _, _| async {
        Ok(RpcResult::value(Done { success: true }))
    });
    assert!(matches!(
        result,
        Err(ContractError::MismatchedHandler("auth.status"))
    ));
}

#[test]
fn duplicate_handler_returns_a_binding_error() {
    let mut registry = RpcRegistry::new().unwrap();
    let handler = |_, _, _| async {
        Ok(RpcResult::value(AuthStatus {
            initialized: false,
            user: Nullable(None),
        }))
    };
    registry
        .bind::<Empty, AuthStatus, _, _>("auth.status", handler)
        .unwrap();
    assert!(matches!(
        registry.bind::<Empty, AuthStatus, _, _>("auth.status", handler),
        Err(ContractError::DuplicateHandler("auth.status"))
    ));
}

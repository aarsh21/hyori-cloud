use crate::error::ApiError;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::collections::BTreeMap;

/// Contract construction failures are startup errors, never request-controlled panics.
#[derive(Debug, thiserror::Error)]
pub enum ContractError {
    #[error("contract schema serialization failed")]
    Serialization(#[from] serde_json::Error),
    #[error("schema {0} must be a JSON object")]
    InvalidSchema(String),
    #[error("conflicting schema {0}")]
    ConflictingSchema(String),
    #[error("duplicate operation {0}")]
    DuplicateOperation(&'static str),
    #[error("missing schema {0}")]
    MissingSchema(String),
    #[error("invalid runtime validator for schema {0}")]
    InvalidValidator(String),
    #[error("handler {0} has no declared operation")]
    UndeclaredHandler(&'static str),
    #[error("handler {0} does not match its declared input/output types")]
    MismatchedHandler(&'static str),
    #[error("duplicate handler {0}")]
    DuplicateHandler(&'static str),
}

/// Result of composing feature-owned schemas, operations and handlers.
pub type ContractResult<T> = Result<T, ContractError>;

#[macro_export]
macro_rules! wire_struct {
    ($name:ident { $($(#[$meta:meta])* $field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $($(#[$meta])* pub $field: $ty),* }
    };
}
#[macro_export]
macro_rules! wire_enum {
    ($name:ident { $($variant:ident => $value:literal),* $(,)? }) => {
        #[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema, PartialEq, Eq)]
        pub enum $name { $(#[serde(rename = $value)] $variant),* }
    };
}
#[macro_export]
macro_rules! schemas { ($m:expr; $($t:ty),* $(,)?) => { $($m.schema::<$t>()?;)* }; }
#[macro_export]
macro_rules! operation {
    ($m:expr, $name:literal, $input:ty, $output:ty, $kind:literal, [$($invalidate:literal),*], $reset:literal) => {
        $m.operation::<$input, $output>($name, $kind, &[$($invalidate),*], $reset)?;
    };
}

/// Required but nullable, unlike an omitted optional property.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Nullable<T>(pub Option<T>);
impl<T: JsonSchema> JsonSchema for Nullable<T> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Nullable_{}", T::schema_name()).into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        <Option<T>>::json_schema(generator)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub name: &'static str,
    pub input: String,
    pub output: String,
    pub error: &'static str,
    pub kind: &'static str,
    pub invalidates: Vec<&'static str>,
    pub reset_cache: bool,
}
#[derive(Debug, Default, Serialize)]
pub struct Manifest {
    pub schemas: BTreeMap<String, Value>,
    pub operations: Vec<Operation>,
}
impl Manifest {
    /// Register a schema and its definitions, rejecting name collisions.
    pub fn schema<T: JsonSchema>(&mut self) -> ContractResult<()> {
        let name = T::schema_name().into_owned();
        let mut root = serde_json::to_value(schemars::schema_for!(T))?;
        let object = root
            .as_object_mut()
            .ok_or_else(|| ContractError::InvalidSchema(name.clone()))?;
        if let Some(definitions) = object.remove("$defs") {
            let definitions = definitions
                .as_object()
                .ok_or_else(|| ContractError::InvalidSchema(name.clone()))?;
            for (name, schema) in definitions {
                self.insert_schema(name.clone(), schema.clone())?;
            }
        }
        self.insert_schema(name, root)
    }
    fn insert_schema(&mut self, name: String, mut schema: Value) -> ContractResult<()> {
        let object = schema
            .as_object_mut()
            .ok_or_else(|| ContractError::InvalidSchema(name.clone()))?;
        object.remove("$schema");
        object.remove("title");
        if let Some(previous) = self.schemas.get(&name) {
            if previous != &schema {
                return Err(ContractError::ConflictingSchema(name));
            }
        } else {
            self.schemas.insert(name, schema);
        }
        Ok(())
    }
    /// Add one feature operation and derive its named input/output schemas.
    pub fn operation<I: JsonSchema, O: JsonSchema>(
        &mut self,
        name: &'static str,
        kind: &'static str,
        invalidates: &[&'static str],
        reset_cache: bool,
    ) -> ContractResult<()> {
        if self
            .operations
            .iter()
            .any(|operation| operation.name == name)
        {
            return Err(ContractError::DuplicateOperation(name));
        }
        self.schema::<I>()?;
        self.schema::<O>()?;
        self.operations.push(Operation {
            name,
            input: I::schema_name().into_owned(),
            output: O::schema_name().into_owned(),
            error: "ApiError",
            kind,
            invalidates: invalidates.to_vec(),
            reset_cache,
        });
        Ok(())
    }
}
/// Compose the product contract without connecting to databases or storage.
pub fn manifest() -> ContractResult<Manifest> {
    let mut m = Manifest::default();
    m.schema::<ApiError>()?;
    crate::features::auth::api::register(&mut m)?;
    crate::features::files::api::register(&mut m)?;
    crate::features::uploads::api::register(&mut m)?;
    crate::features::shares::api::register(&mut m)?;
    crate::features::admin::api::register(&mut m)?;
    crate::features::photos::api::register(&mut m)?;
    crate::features::media::api::register(&mut m)?;
    crate::features::editors::api::register(&mut m)?;
    Ok(m)
}
pub fn decode<T: JsonSchema + DeserializeOwned>(input: Value) -> Result<T, ApiError> {
    let schema =
        serde_json::to_value(schemars::schema_for!(T)).map_err(|_| ApiError::unavailable())?;
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .map_err(|_| ApiError::unavailable())?;
    if !validator.is_valid(&input) {
        return Err(ApiError::invalid());
    }
    serde_json::from_value(input).map_err(|_| ApiError::invalid())
}

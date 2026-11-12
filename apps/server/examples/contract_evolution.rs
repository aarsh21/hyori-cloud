//! Architecture acceptance fixture: a Rust feature addition must reach public SDK/Query types.
//! This is not mounted by the product server and uses the workspace's exact dependency lock.

use hyori_server::wire::manifest;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(JsonSchema, Serialize, Deserialize)]
struct ProbeInput {
    seed: f64,
}
#[derive(JsonSchema, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProbeState {
    Ready,
    Waiting,
}
#[derive(JsonSchema, Serialize, Deserialize)]
struct ProbeOutput {
    revision: f64,
    state: ProbeState,
}
#[derive(JsonSchema, Serialize, Deserialize)]
enum ProbeErrorCode {
    #[serde(rename = "fixture.old")]
    Old,
    #[serde(rename = "fixture.new")]
    New,
}
#[derive(JsonSchema, Serialize, Deserialize)]
struct ProbeError {
    code: ProbeErrorCode,
    message: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut definition = manifest()?;
    definition.operation::<ProbeInput, ProbeOutput>("evolution.probe", "query", &[], false)?;
    definition.schema::<ProbeError>()?;
    definition
        .operations
        .last_mut()
        .ok_or("new operation missing")?
        .error = "ProbeError";
    serde_json::to_writer(std::io::stdout(), &definition)?;
    Ok(())
}

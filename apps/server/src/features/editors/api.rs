use crate::{
    features::{
        auth::api::{Bytes, Done, Empty, Id, Name},
        files::api::{Download, FileEntry, ItemInput},
        uploads::api::UploadStatus,
    },
    wire::{Manifest, Nullable},
};

crate::wire_enum!(EditorApp { Wordcraft => "wordcraft", Gridcraft => "gridcraft", Deckcraft => "deckcraft", Pdfcraft => "pdfcraft" });
crate::wire_enum!(EditorBridge { Upstream => "upstream-host-parent", CorrelatedV1 => "hyori-correlated-host-v1", CorrelatedV2 => "hyori-correlated-host-v2", CorrelatedV3 => "hyori-correlated-host-v3" });
crate::wire_enum!(EditorSaveMode { Manual => "manual", Automatic => "automatic" });
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditorProtocol(pub u8);
impl schemars::JsonSchema for EditorProtocol {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "EditorProtocol".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({"type": "integer", "enum": [1, 2, 3]})
    }
}
crate::wire_enum!(EditorOutputKind { Document => "document", Export => "export" });
crate::wire_enum!(EditorIntent { Replace => "replace", SaveAs => "save-as", Export => "export" });
crate::wire_struct!(EditorOutputFormat {
    #[schemars(regex(pattern = r"^\.[a-z0-9]{1,16}$"))]
    extension: String,
    kind: EditorOutputKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64", range(min = 1, max = 67108864))]
    max_bytes: Option<Bytes>
});
crate::wire_struct!(EditorAvailableApp {
    app: EditorApp,
    #[schemars(length(min = 1, max = 64))]
    version: String,
    #[schemars(length(min = 1, max = 32))]
    input_extensions: Vec<String>
});
crate::wire_struct!(EditorAvailability {
    #[schemars(length(max = 4))]
    apps: Vec<EditorAvailableApp>
});
// The editor's WASM engine, which the host fetches from its own cache and hands to the sandboxed
// frame: an opaque-origin frame can't use the HTTP cache, so it would download it on every open.
crate::wire_struct!(EditorEngine {
    #[schemars(
        length(max = 256),
        regex(
            pattern = r"^/artcraft/(wordcraft|gridcraft|deckcraft|pdfcraft)/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+_bg\.wasm$"
        )
    )]
    url: String,
    #[schemars(regex(pattern = r"^[0-9a-f]{64}$"))]
    sha256: String,
    #[schemars(with = "u64", range(min = 1, max = 134217728))]
    bytes: Bytes
});
crate::wire_struct!(EditorDocument {
    session_id: Id,
    app: EditorApp,
    bridge: EditorBridge,
    protocol: Nullable<EditorProtocol>,
    #[schemars(length(min = 1, max = 64))]
    version: String,
    #[schemars(length(max = 256), regex(pattern = r"^/artcraft/(wordcraft|gridcraft|deckcraft|pdfcraft)/[a-zA-Z0-9._-]+/index\.html\?host=parent$"))]
    asset_url: String,
    name: Name,
    #[schemars(length(min = 1, max = 32), regex(pattern = r"^[0-9]+$"))]
    revision: String,
    writable: bool,
    #[schemars(with = "u64", range(min = 1, max = 67108864))]
    max_bytes: Bytes,
    replacement_name: Nullable<Name>,
    #[schemars(length(min = 1, max = 32))]
    output_formats: Vec<EditorOutputFormat>,
    /// Display name for new PDF annotations only; no account identity enters the frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    annotation_author: Option<Name>,
    /// Present for runtimes whose sandboxed frame asks the host for its engine (protocol 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<EditorEngine>
});
crate::wire_struct!(EditorCloseInput { session_id: Id });
crate::wire_struct!(EditorDownloadInput {
    session_id: Id,
    #[schemars(length(min = 1, max = 32), regex(pattern = r"^[0-9]+$"))]
    expected_revision: String
});
crate::wire_struct!(EditorDestination { parent_id: Nullable<Id> });
crate::wire_struct!(EditorCopyNameInput { session_id: Id, parent_id: Nullable<Id>, name: Name, intent: EditorIntent });
crate::wire_struct!(EditorPrepareSave {
    session_id: Id,
    #[schemars(length(min = 1, max = 160), regex(pattern = r"^[a-zA-Z0-9_:-]+$"))]
    save_id: String,
    #[schemars(length(min = 1, max = 32), regex(pattern = r"^[0-9]+$"))]
    expected_revision: String,
    name: Name,
    size: Bytes,
    #[schemars(regex(pattern = r"^[a-f0-9]{64}$"))]
    sha256: String,
    intent: EditorIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "EditorSaveMode")]
    save_mode: Option<EditorSaveMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "EditorDestination")]
    destination: Option<EditorDestination>
});
crate::wire_struct!(EditorSaveInput {
    session_id: Id,
    #[schemars(length(min = 1, max = 160), regex(pattern = r"^[a-zA-Z0-9_:-]+$"))]
    save_id: String
});
crate::wire_enum!(EditorSavedStatus { Saved => "saved" });
crate::wire_struct!(EditorSaved {
    status: EditorSavedStatus,
    #[schemars(length(min = 1, max = 32), regex(pattern = r"^[0-9]+$"))]
    revision: String,
    file: FileEntry
});

pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::editors::service::EditorsService, rpc::RpcResult};
    registry.bind::<EditorCloseInput, Done, _, _>(
        "editors.close",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .close(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<Empty, EditorAvailability, _, _>(
        "editors.available",
        |state, context, _| async move {
            EditorsService::new(state, context)
                .available()
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<ItemInput, EditorDocument, _, _>(
        "editors.open",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .open(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<EditorDownloadInput, Download, _, _>(
        "editors.download",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .download(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<EditorPrepareSave, UploadStatus, _, _>(
        "editors.prepareSave",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .prepare_save(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<EditorCopyNameInput, Name, _, _>(
        "editors.suggestCopyName",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .suggest_copy_name(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<EditorSaveInput, EditorSaved, _, _>(
        "editors.completeSave",
        |state, context, input| async move {
            EditorsService::new(state, context)
                .complete_save(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; EditorAvailability, EditorDocument, EditorCloseInput, EditorDownloadInput, EditorCopyNameInput, EditorPrepareSave, EditorSaveInput, EditorSaved);
    crate::operation!(
        m,
        "editors.suggestCopyName",
        EditorCopyNameInput,
        Name,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.close",
        EditorCloseInput,
        Done,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.available",
        Empty,
        EditorAvailability,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.open",
        ItemInput,
        EditorDocument,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.download",
        EditorDownloadInput,
        Download,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.prepareSave",
        EditorPrepareSave,
        UploadStatus,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "editors.completeSave",
        EditorSaveInput,
        EditorSaved,
        "mutation",
        ["files", "auth", "photos", "admin", "media"],
        false
    );
    Ok(())
}

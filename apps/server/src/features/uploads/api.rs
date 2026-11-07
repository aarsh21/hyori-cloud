use crate::{
    features::{
        auth::api::{Bytes, Done, Empty, Id, Name},
        files::api::FileEntry,
    },
    wire::{Manifest, Nullable},
};
use std::collections::BTreeMap;
crate::wire_struct!(BeginUpload { parent_id: Nullable<Id>, name: Name, size: Bytes, #[schemars(length(max = 128))] mime_type: String, #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Id")] replace_id: Option<Id> });
crate::wire_struct!(UploadInput { upload_id: Id });
crate::wire_struct!(UploadPartInput {
    upload_id: Id,
    #[schemars(range(min = 1, max = 10000))]
    part_number: u32
});
crate::wire_enum!(UploadState { Uploading => "uploading", Complete => "complete", Aborted => "aborted" });
crate::wire_struct!(AcknowledgedPart {
    #[schemars(range(min = 1, max = 10000))]
    part_number: u32,
    size: Bytes
});
crate::wire_struct!(UploadStatus { upload_id: Id, chunk_size: Bytes, total_parts: Bytes, parts: Vec<AcknowledgedPart>, state: UploadState, file_id: Nullable<Id> });
crate::wire_struct!(IncomingUpload {
    upload_id: Id,
    #[schemars(length(max = 255))]
    name: String,
    size: Bytes,
    expires_at: String,
    anonymous: bool
});
crate::wire_struct!(IncomingUploads {
    #[schemars(length(max = 128))]
    items: Vec<IncomingUpload>
});
crate::wire_enum!(PutMethod { Put => "PUT" });
crate::wire_struct!(UploadPart { url: String, method: PutMethod, headers: BTreeMap<String, String> });
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::uploads::service::UploadsService, rpc::RpcResult};
    registry.bind::<BeginUpload, UploadStatus, _, _>(
        "uploads.begin",
        |state, context, input| async move {
            UploadsService::new(state, context)
                .begin(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<UploadInput, UploadStatus, _, _>(
        "uploads.status",
        |state, context, input| async move {
            UploadsService::new(state, context)
                .status(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<UploadPartInput, UploadPart, _, _>(
        "uploads.part",
        |state, context, input| async move {
            UploadsService::new(state, context)
                .part(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<UploadInput, FileEntry, _, _>(
        "uploads.complete",
        |state, context, input| async move {
            UploadsService::new(state, context)
                .complete(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<UploadInput, Done, _, _>(
        "uploads.abort",
        |state, context, input| async move {
            UploadsService::new(state, context)
                .abort(input)
                .await
                .map(RpcResult::value)
        },
    )?;
    registry.bind::<Empty, IncomingUploads, _, _>(
        "uploads.incoming",
        |state, context, _| async move {
            UploadsService::new(state, context)
                .incoming()
                .await
                .map(RpcResult::value)
        },
    )?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; BeginUpload, UploadInput, UploadPartInput, UploadStatus, UploadPart, AcknowledgedPart, IncomingUploads);
    crate::operation!(
        m,
        "uploads.begin",
        BeginUpload,
        UploadStatus,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "uploads.status",
        UploadInput,
        UploadStatus,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "uploads.part",
        UploadPartInput,
        UploadPart,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "uploads.complete",
        UploadInput,
        FileEntry,
        "mutation",
        ["files", "auth", "photos", "admin", "media"],
        false
    );
    crate::operation!(
        m,
        "uploads.abort",
        UploadInput,
        Done,
        "mutation",
        ["auth", "uploads"],
        false
    );
    crate::operation!(
        m,
        "uploads.incoming",
        Empty,
        IncomingUploads,
        "query",
        [],
        false
    );
    Ok(())
}

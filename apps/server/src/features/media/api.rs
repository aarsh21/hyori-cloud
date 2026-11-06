use crate::{
    features::{auth::api::Bytes, files::api::ItemInput},
    wire::Manifest,
};
crate::wire_enum!(DerivativeKind { Thumbnail=>"thumbnail", Poster=>"poster" });
crate::wire_enum!(DerivativeFailure { Unavailable=>"unavailable", InvalidMedia=>"invalidMedia", ResourceLimit=>"resourceLimit", Unsupported=>"unsupported", Timeout=>"timeout", Busy=>"busy" });
crate::wire_struct!(MediaIdentity {
    kind: DerivativeKind,
    source_revision: Bytes
});
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MediaDerivative {
    Unavailable {
        #[serde(flatten)]
        identity: MediaIdentity,
    },
    Queued {
        #[serde(flatten)]
        identity: MediaIdentity,
    },
    Processing {
        #[serde(flatten)]
        identity: MediaIdentity,
    },
    Ready {
        #[serde(flatten)]
        identity: MediaIdentity,
        url: String,
        #[schemars(range(min = 1, max = 256))]
        width: u32,
        #[schemars(range(min = 1, max = 256))]
        height: u32,
    },
    Unsupported {
        #[serde(flatten)]
        identity: MediaIdentity,
        failure: DerivativeFailure,
    },
    Failed {
        #[serde(flatten)]
        identity: MediaIdentity,
        failure: DerivativeFailure,
        can_retry: bool,
    },
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; DerivativeKind,DerivativeFailure,MediaIdentity,MediaDerivative);
    crate::operation!(
        m,
        "media.get",
        ItemInput,
        MediaDerivative,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "media.retry",
        ItemInput,
        MediaDerivative,
        "mutation",
        ["media", "photos"],
        false
    );
    Ok(())
}
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::media::service::MediaService, rpc::RpcResult};
    registry.bind::<ItemInput, MediaDerivative, _, _>(
        "media.get",
        |state, context, input| async move {
            Ok(RpcResult::value(
                MediaService::new(&state, context).get(input).await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, MediaDerivative, _, _>(
        "media.retry",
        |state, context, input| async move {
            Ok(RpcResult::value(
                MediaService::new(&state, context).retry(input).await?,
            ))
        },
    )?;
    Ok(())
}

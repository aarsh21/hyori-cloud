use crate::{
    features::{
        auth::api::{Done, Id, Timestamp},
        files::api::{FileEntry, ShareRole},
    },
    wire::{Manifest, Nullable},
};
crate::wire_struct!(Share { id: Id, item_id: Id, role: ShareRole, recipient_id: Nullable<Id>, public: bool, expires_at: Nullable<String>, password_protected: bool, revoked_at: Nullable<String>, url: Nullable<String> });
crate::wire_struct!(SharesListInput { item_id: Id });
crate::wire_struct!(SharesList { items: Vec<Share> });
crate::wire_struct!(CreateShare {
    item_id: Id, role: ShareRole,
    #[serde(default, skip_serializing_if = "Option::is_none")] recipient_id: Option<Nullable<Id>>,
    public: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "String", length(min = 8, max = 1024))] password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] expires_at: Option<Nullable<Timestamp>>
});
crate::wire_struct!(ShareInput { id: Id });
crate::wire_struct!(ResolveShare {
    #[schemars(length(max = 256))]
    token: String
});
crate::wire_struct!(UnlockShare {
    #[schemars(length(max = 256))]
    token: String,
    #[schemars(length(max = 1024))]
    password: String
});
crate::wire_struct!(ResolvedShare { share: Share, item: Nullable<FileEntry>, requires_password: bool });
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::shares::service::SharesService, rpc::RpcResult};
    registry.bind::<SharesListInput, SharesList, _, _>(
        "shares.list",
        |state, context, input| async move {
            Ok(RpcResult::value(
                SharesService::new(&state, context).list(input).await?,
            ))
        },
    )?;
    registry.bind::<CreateShare, Share, _, _>(
        "shares.create",
        |state, context, input| async move {
            Ok(RpcResult::value(
                SharesService::new(&state, context).create(input).await?,
            ))
        },
    )?;
    registry.bind::<ShareInput, Done, _, _>(
        "shares.revoke",
        |state, context, input| async move {
            Ok(RpcResult::value(
                SharesService::new(&state, context).revoke(input).await?,
            ))
        },
    )?;
    registry.bind::<ResolveShare, ResolvedShare, _, _>("shares.resolve", |state, context, input| async move {
        SharesService::new(&state, context).resolve(input).await
    })?;
    registry.bind::<UnlockShare, ResolvedShare, _, _>("shares.unlock", |state, context, input| async move {
        SharesService::new(&state, context).unlock(input).await
    })?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; Share, SharesListInput, SharesList, CreateShare, ShareInput, ResolveShare, UnlockShare, ResolvedShare);
    crate::operation!(
        m,
        "shares.list",
        SharesListInput,
        SharesList,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "shares.create",
        CreateShare,
        Share,
        "mutation",
        ["shares", "files", "photos", "media"],
        false
    );
    crate::operation!(
        m,
        "shares.revoke",
        ShareInput,
        Done,
        "mutation",
        ["shares", "files", "photos", "media"],
        false
    );
    crate::operation!(
        m,
        "shares.resolve",
        ResolveShare,
        ResolvedShare,
        "mutation",
        ["files", "shares", "photos", "media"],
        false
    );
    crate::operation!(
        m,
        "shares.unlock",
        UnlockShare,
        ResolvedShare,
        "mutation",
        ["files", "shares", "photos", "media"],
        false
    );
    Ok(())
}

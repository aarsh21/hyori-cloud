use crate::{
    features::auth::api::{Bytes, Id, NewAccount, Timestamp, User},
    wire::{Manifest, Nullable},
};
crate::wire_enum!(AccountStatus { Active => "active", Deleting => "deleting" });
crate::wire_struct!(AdminUser {
    #[serde(flatten)]
    user: User,
    status: AccountStatus,
    reserved_bytes: Bytes
});
crate::wire_struct!(UsersList { items: Vec<AdminUser>, next_cursor: Nullable<String> });
crate::wire_struct!(UsersInput { #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Nullable<String>> });
crate::wire_struct!(CreateUser { #[serde(flatten)] account: NewAccount, #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Bytes")] quota_bytes: Option<Bytes> });
crate::wire_struct!(CreateInvite {
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "String", length(max = 254))] email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Timestamp")] expires_at: Option<Timestamp>
});
crate::wire_struct!(Invite {
    token: String,
    expires_at: String
});
crate::wire_struct!(SetQuota {
    user_id: Id,
    quota_bytes: Bytes
});
crate::wire_struct!(DeleteUser {
    user_id: Id,
    confirm_email: String
});
crate::wire_enum!(PurgeState { Complete => "complete", Pending => "pending" });
crate::wire_struct!(PurgeResult {
    user_id: Id,
    state: PurgeState,
    deleted_objects: Bytes
});
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{
        features::{admin::service::AdminService, auth::service::AuthService},
        rpc::RpcResult,
    };
    registry.bind::<UsersInput, UsersList, _, _>(
        "admin.users",
        |state, context, input| async move {
            Ok(RpcResult::value(
                AdminService::new(&state, context).users(input).await?,
            ))
        },
    )?;
    registry.bind::<SetQuota, User, _, _>(
        "admin.setQuota",
        |state, context, input| async move {
            Ok(RpcResult::value(
                AdminService::new(&state, context).set_quota(input).await?,
            ))
        },
    )?;
    registry.bind::<DeleteUser, PurgeResult, _, _>(
        "admin.deleteUser",
        |state, context, input| async move {
            Ok(RpcResult::value(
                AdminService::new(&state, context)
                    .delete_user(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<CreateUser, User, _, _>(
        "admin.createUser",
        |state, context, input| async move {
            Ok(RpcResult::value(
                AuthService::new(&state)
                    .create_user(context.session.as_deref(), input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<CreateInvite, Invite, _, _>(
        "admin.createInvite",
        |state, context, input| async move {
            Ok(RpcResult::value(
                AuthService::new(&state)
                    .create_invite(context.session.as_deref(), input)
                    .await?,
            ))
        },
    )?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; AdminUser, UsersList, UsersInput, CreateUser, CreateInvite, Invite, SetQuota, DeleteUser, PurgeResult);
    crate::operation!(m, "admin.users", UsersInput, UsersList, "query", [], false);
    crate::operation!(
        m,
        "admin.createUser",
        CreateUser,
        User,
        "mutation",
        ["admin"],
        false
    );
    crate::operation!(
        m,
        "admin.createInvite",
        CreateInvite,
        Invite,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "admin.setQuota",
        SetQuota,
        User,
        "mutation",
        ["admin", "auth"],
        false
    );
    crate::operation!(
        m,
        "admin.deleteUser",
        DeleteUser,
        PurgeResult,
        "mutation",
        ["admin", "shares", "files", "photos", "media"],
        false
    );
    Ok(())
}

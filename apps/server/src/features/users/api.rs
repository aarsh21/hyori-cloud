use crate::{features::auth::api::Id, wire::Manifest};

crate::wire_struct!(UserIdentity {
    id: Id,
    name: String,
    email: String
});
crate::wire_struct!(SearchUsers { query: String });
crate::wire_struct!(UserSearchResults { items: Vec<UserIdentity> });

pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::users::service, rpc::RpcResult};
    registry.bind::<SearchUsers, UserSearchResults, _, _>(
        "users.search",
        |state, context, input| async move {
            Ok(RpcResult::value(
                service::search(&state, context.session.as_deref(), input).await?,
            ))
        },
    )
}

pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; UserIdentity);
    crate::operation!(
        m,
        "users.search",
        SearchUsers,
        UserSearchResults,
        "query",
        [],
        false
    );
    Ok(())
}

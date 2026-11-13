use crate::{
    features::auth::api::{Done, Id},
    wire::Manifest,
};

crate::wire_struct!(CollaborationOpen {
    id: Id,
    #[schemars(regex(pattern = r"^[0-9]{1,16}$"))]
    client_id: String,
    #[schemars(range(min = 1, max = 1))]
    schema_version: u32
});
crate::wire_struct!(CollaborationDocument {
    session_id: Id,
    generation: Id,
    schema_version: u32,
    state: String,
    sequence: String,
    writable: bool,
    name: String,
    color: String
});
crate::wire_struct!(CollaborationSync {
    session_id: Id,
    generation: Id,
    #[schemars(length(max = 32768), regex(pattern = r"^[a-f0-9]*$"))]
    vector: String,
    #[schemars(length(max = 196608), regex(pattern = r"^[a-f0-9]*$"))]
    update: String,
    #[schemars(length(max = 4096))]
    presence: String
});
crate::wire_struct!(CollaborationPeer {
    client_id: String,
    presence: String
});
crate::wire_struct!(CollaborationReceipt {
    sequence: String, update: String, acknowledged: String, writable: bool,
    peers: Vec<CollaborationPeer>
});
crate::wire_struct!(CollaborationClose { session_id: Id });
pub fn bind(r: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use super::service::CollaborationService;
    use crate::rpc::RpcResult;
    r.bind::<CollaborationOpen, CollaborationDocument, _, _>(
        "collaboration.open",
        |s, c, i| async move {
            CollaborationService::new(&s, c)
                .open(i)
                .await
                .map(RpcResult::value)
        },
    )?;
    r.bind::<CollaborationSync, CollaborationReceipt, _, _>(
        "collaboration.sync",
        |s, c, i| async move {
            CollaborationService::new(&s, c)
                .sync(i)
                .await
                .map(RpcResult::value)
        },
    )?;
    r.bind::<CollaborationClose, Done, _, _>("collaboration.close", |s, c, i| async move {
        CollaborationService::new(&s, c)
            .close(i)
            .await
            .map(RpcResult::value)
    })?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::operation!(
        m,
        "collaboration.open",
        CollaborationOpen,
        CollaborationDocument,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "collaboration.sync",
        CollaborationSync,
        CollaborationReceipt,
        "mutation",
        [],
        false
    );
    crate::operation!(
        m,
        "collaboration.close",
        CollaborationClose,
        Done,
        "mutation",
        [],
        false
    );
    Ok(())
}

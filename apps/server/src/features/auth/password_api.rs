use super::{
    api::{Done, Id, NEW_PASSWORD_MIN_CHARS, PASSWORD_MAX_CHARS},
    passwords::PasswordService,
};
use crate::{rpc::RpcResult, wire::Manifest};

crate::wire_struct!(ChangePassword {
    #[schemars(length(min = 1, max = PASSWORD_MAX_CHARS))]
    current_password: String,
    #[schemars(length(min = NEW_PASSWORD_MIN_CHARS, max = PASSWORD_MAX_CHARS))]
    new_password: String
});
crate::wire_struct!(ResetPassword {
    #[schemars(regex(pattern = r"^[a-f0-9]{64}$"))]
    token: String,
    #[schemars(length(min = NEW_PASSWORD_MIN_CHARS, max = PASSWORD_MAX_CHARS))]
    new_password: String
});
crate::wire_struct!(CreatePasswordReset { user_id: Id });
crate::wire_struct!(PasswordResetLink {
    token: String,
    expires_at: String
});
crate::wire_struct!(PasswordResetResult {
    #[serde(flatten)]
    done: Done,
    user_id: Id
});

pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    registry.bind::<ChangePassword, Done, _, _>(
        "auth.changePassword",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PasswordService::new(&state).change(&context, input).await?,
            ))
        },
    )?;
    registry.bind::<ResetPassword, PasswordResetResult, _, _>(
        "auth.resetPassword",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PasswordService::new(&state).reset(&context, input).await?,
            ))
        },
    )?;
    registry.bind::<CreatePasswordReset, PasswordResetLink, _, _>(
        "admin.createPasswordReset",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PasswordService::new(&state)
                    .create_reset(&context, input)
                    .await?,
            ))
        },
    )?;
    Ok(())
}

pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; ChangePassword, ResetPassword, CreatePasswordReset, PasswordResetLink, PasswordResetResult);
    crate::operation!(
        m,
        "auth.changePassword",
        ChangePassword,
        Done,
        "mutation",
        ["auth"],
        true
    );
    crate::operation!(
        m,
        "auth.resetPassword",
        ResetPassword,
        PasswordResetResult,
        "mutation",
        ["auth"],
        true
    );
    crate::operation!(
        m,
        "admin.createPasswordReset",
        CreatePasswordReset,
        PasswordResetLink,
        "mutation",
        [],
        false
    );
    Ok(())
}

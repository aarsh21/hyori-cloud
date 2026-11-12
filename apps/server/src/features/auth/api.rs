use crate::wire::{Manifest, Nullable};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Account-password minimum, measured in Unicode scalar values before normalization.
pub const NEW_PASSWORD_MIN_CHARS: usize = 12;
/// Password maximum shared by account creation, login and generated wire validators.
pub const PASSWORD_MAX_CHARS: usize = 1024;
/// Minimum configured bootstrap-token length, measured like the public wire contract.
pub const SETUP_TOKEN_MIN_CHARS: usize = 24;
/// Maximum configured/submitted bootstrap-token length.
pub const SETUP_TOKEN_MAX_CHARS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct Id(#[schemars(regex(pattern = r"^[a-zA-Z0-9_-]{1,128}$"))] pub String);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct Name(#[schemars(length(min = 1, max = 255))] pub String);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct Bytes(#[schemars(range(min = 0, max = 9007199254740991_u64))] pub u64);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Timestamp(
    #[schemars(length(max = 40), extend("anyOf" = [{"format": "date"}, {"format": "date-time"}]))]
    pub String,
);
impl Timestamp {
    pub fn parse(&self) -> Result<chrono::DateTime<chrono::Utc>, crate::error::ApiError> {
        if let Ok(value) = chrono::DateTime::parse_from_rfc3339(&self.0) {
            return Ok(value.with_timezone(&chrono::Utc));
        }
        chrono::NaiveDate::parse_from_str(&self.0, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .map(|date| date.and_utc())
            .ok_or_else(crate::error::ApiError::invalid)
    }
}

crate::wire_struct!(Empty {});
// A boolean singleton is distinct from the string literal "true".
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Done {
    #[schemars(with = "bool", extend("const" = true))]
    pub success: bool,
}
crate::wire_enum!(UserRole { Admin => "admin", User => "user" });
crate::wire_struct!(User {
    id: Id,
    email: String,
    name: Name,
    role: UserRole,
    quota_bytes: Bytes,
    used_bytes: Bytes
});
crate::wire_struct!(AuthStatus { initialized: bool, user: Nullable<User> });
crate::wire_struct!(Credentials {
    #[schemars(length(max = 254))]
    email: String,
    #[schemars(length(min = 1, max = PASSWORD_MAX_CHARS))]
    password: String
});
crate::wire_struct!(NewAccount {
    #[schemars(length(max = 254))]
    email: String,
    name: Name,
    #[schemars(length(min = NEW_PASSWORD_MIN_CHARS, max = PASSWORD_MAX_CHARS))]
    password: String
});
crate::wire_struct!(Setup {
    #[serde(flatten)]
    account: NewAccount,
    #[schemars(length(max = SETUP_TOKEN_MAX_CHARS))]
    setup_token: String
});
crate::wire_struct!(AcceptInvite {
    #[serde(flatten)]
    account: NewAccount,
    #[schemars(length(max = 256))]
    token: String
});

pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::auth::service::AuthService, rpc::RpcResult};
    registry.bind::<Empty, AuthStatus, _, _>("auth.status", |state, context, _| async move {
        Ok(RpcResult::value(
            AuthService::new(&state)
                .status(context.session.as_deref())
                .await?,
        ))
    })?;
    registry.bind::<Setup, User, _, _>("auth.setup", |state, context, input| async move {
        let issued = AuthService::new(&state).setup(input, &context).await?;
        Ok(RpcResult {
            value: issued.user,
            cookies: vec![state.auth.cookie(Some(&issued.token))],
        })
    })?;
    registry.bind::<Credentials, User, _, _>("auth.login", |state, context, input| async move {
        let (issued, device) = AuthService::new(&state).login(input, &context).await?;
        Ok(RpcResult {
            value: issued.user,
            cookies: vec![state.auth.cookie(Some(&issued.token)), device],
        })
    })?;
    registry.bind::<Empty, Done, _, _>("auth.logout", |state, context, _| async move {
        let value = AuthService::new(&state)
            .logout(context.session.as_deref())
            .await?;
        Ok(RpcResult {
            value,
            cookies: vec![state.auth.cookie(None)],
        })
    })?;
    registry.bind::<AcceptInvite, User, _, _>(
        "auth.acceptInvite",
        |state, context, input| async move {
            let issued = AuthService::new(&state)
                .accept_invite(input, &context)
                .await?;
            Ok(RpcResult {
                value: issued.user,
                cookies: vec![state.auth.cookie(Some(&issued.token))],
            })
        },
    )?;
    super::password_api::bind(registry)
}

pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; Id, Name, Bytes, Timestamp, Empty, Done, User, AuthStatus, Credentials, NewAccount, Setup, AcceptInvite);
    crate::operation!(m, "auth.status", Empty, AuthStatus, "query", [], false);
    crate::operation!(m, "auth.setup", Setup, User, "mutation", ["auth"], true);
    crate::operation!(
        m,
        "auth.login",
        Credentials,
        User,
        "mutation",
        ["auth"],
        true
    );
    crate::operation!(m, "auth.logout", Empty, Done, "mutation", ["auth"], true);
    crate::operation!(
        m,
        "auth.acceptInvite",
        AcceptInvite,
        User,
        "mutation",
        ["auth"],
        true
    );
    super::password_api::register(m)
}

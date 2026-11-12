//! Fail-closed surface required by Better Auth alpha.5. No optional plugins are installed.
use super::store::*;
use async_trait::async_trait;
use better_auth_core::{self as ba, AuthError, AuthResult, store::*, types::*};

#[async_trait]
impl VerificationStore<HyoriSchema> for PgStore {
    async fn update_verification(
        &self,
        _identifier: &str,
        _update: database_hooks::VerificationUpdate,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn reserve_verification(
        &self,
        _id: &str,
        _verification: CreateVerification,
    ) -> AuthResult<bool> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_verification_including_expired(
        &self,
        _identifier: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_verification_by_identifier(
        &self,
        _identifier: &str,
        _value: Option<String>,
        _expires_at: Option<chrono::DateTime<chrono::Utc>>,
    ) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_verification_by_identifier(&self, _identifier: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn create_verification(
        &self,
        _verification: CreateVerification,
    ) -> AuthResult<ba::wire::VerificationView> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_verification(
        &self,
        _identifier: &str,
        _value: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_verification_by_value(
        &self,
        _value: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_verification_by_identifier(
        &self,
        _identifier: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn consume_verification(
        &self,
        _identifier: &str,
        _value: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn consume_verification_by_identifier(
        &self,
        _identifier: &str,
    ) -> AuthResult<Option<ba::wire::VerificationView>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_verification(&self, _id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_expired_verifications(&self) -> AuthResult<usize> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl OrganizationStore for PgStore {
    async fn create_organization(&self, _org: CreateOrganization) -> AuthResult<Organization> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_organization_by_id(&self, _id: &str) -> AuthResult<Option<Organization>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_organization_by_slug(&self, _slug: &str) -> AuthResult<Option<Organization>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_organizations_by_ids(&self, _ids: &[String]) -> AuthResult<Vec<Organization>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_organization(
        &self,
        _id: &str,
        _update: UpdateOrganization,
    ) -> AuthResult<Organization> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_organization(&self, _id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_user_organizations(
        &self,
        _user_id: &str,
    ) -> AuthResult<Vec<JoinValue<ba::FieldMap>>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl TeamStore for PgStore {
    async fn create_team(&self, _input: ba::CreateTeam) -> AuthResult<ba::Team> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_team(&self, _id: &str) -> AuthResult<Option<ba::Team>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_team(&self, _id: &str, _update: ba::UpdateTeam) -> AuthResult<ba::Team> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_team(&self, _id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_organization_teams(&self, _organization_id: &str) -> AuthResult<Vec<ba::Team>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_organization_teams(&self, _organization_id: &str) -> AuthResult<u64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_user_teams(&self, _user_id: &str) -> AuthResult<Vec<ba::Team>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_team_member(
        &self,
        _team_id: &str,
        _user_id: &str,
    ) -> AuthResult<Option<ba::TeamMember>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_team_members(&self, _team_id: &str) -> AuthResult<Vec<ba::TeamMember>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_team_members(&self, _team_id: &str) -> AuthResult<u64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn add_team_member(
        &self,
        _team_id: &ba::SchemaValue<String>,
        _user_id: &str,
        _maximum: Option<usize>,
    ) -> AuthResult<Option<ba::TeamMember>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn remove_team_member(&self, _team_id: &str, _user_id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl OrganizationRoleStore for PgStore {
    async fn create_organization_role(
        &self,
        _input: ba::CreateOrganizationRole,
    ) -> AuthResult<ba::OrganizationRole> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_organization_role(&self, _id: &str) -> AuthResult<Option<ba::OrganizationRole>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn find_organization_role(
        &self,
        _organization_id: &str,
        _key: OrganizationRoleKey<'_>,
    ) -> AuthResult<Option<ba::OrganizationRole>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn query_organization_roles(
        &self,
        _organization_id: &str,
        _names: &[String],
    ) -> AuthResult<Vec<ba::OrganizationRole>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_organization_roles(&self, _organization_id: &str) -> AuthResult<u64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_organization_roles(
        &self,
        _organization_id: &str,
    ) -> AuthResult<Vec<ba::OrganizationRole>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_organization_role(
        &self,
        _id: &str,
        _update: ba::UpdateOrganizationRole,
    ) -> AuthResult<ba::OrganizationRole> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_organization_role(&self, _id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl MemberStore for PgStore {
    async fn create_member(&self, _member: CreateMember) -> AuthResult<Member> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_member(
        &self,
        _organization_id: &str,
        _user_id: &str,
    ) -> AuthResult<Option<Member>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_member_by_id(&self, _id: &str) -> AuthResult<Option<Member>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_member_role(&self, _member_id: &str, _role: &str) -> AuthResult<Member> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_member(&self, _member_id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_organization_members(&self, _org_id: &str) -> AuthResult<Vec<Member>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn query_organization_members(
        &self,
        _params: &ListOrganizationMembersParams,
    ) -> AuthResult<(Vec<Member>, usize)> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_organization_members(&self, _org_id: &str) -> AuthResult<i64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_organization_owners(&self, _org_id: &str) -> AuthResult<i64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl InvitationStore for PgStore {
    async fn create_invitation(&self, _invitation: CreateInvitation) -> AuthResult<Invitation> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_invitation_by_id(&self, _id: &str) -> AuthResult<Option<Invitation>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_pending_invitation(
        &self,
        _org_id: &str,
        _email: &str,
    ) -> AuthResult<Option<Invitation>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_invitation_status(
        &self,
        _id: &str,
        _status: InvitationStatus,
    ) -> AuthResult<Option<Invitation>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_invitation_expiry(
        &self,
        _id: &str,
        _expires_at: chrono::DateTime<chrono::Utc>,
    ) -> AuthResult<Invitation> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_organization_invitations(&self, _org_id: &str) -> AuthResult<Vec<Invitation>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_pending_organization_invitations(&self, _org_id: &str) -> AuthResult<i64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_user_invitations(&self, _email: &str) -> AuthResult<Vec<InvitationOrganization>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl TwoFactorStore for PgStore {
    async fn create_two_factor_record(
        &self,
        _input: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_two_factor_record(
        &self,
        _id: &ba::SchemaValue<String>,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_two_factor_record(
        &self,
        _id: &ba::SchemaValue<String>,
        _input: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_two_factor_by_user_id_value(
        &self,
        _user_id: &ba::SchemaValue<String>,
    ) -> AuthResult<Option<TwoFactor>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_two_factor_by_user_id_value(
        &self,
        _user_id: &ba::SchemaValue<String>,
    ) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn create_two_factor(&self, _two_factor: CreateTwoFactor) -> AuthResult<TwoFactor> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_two_factor_backup_codes(
        &self,
        _user_id: &str,
        _backup_codes: &str,
    ) -> AuthResult<TwoFactor> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_two_factor(
        &self,
        _id: &ba::SchemaValue<String>,
        _update: ba::types::UpdateTwoFactor,
    ) -> AuthResult<TwoFactor> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn compare_exchange_two_factor_backup_codes(
        &self,
        _id: &ba::SchemaValue<String>,
        _previous: &ba::FieldValue,
        _replacement: ba::FieldValue,
    ) -> AuthResult<bool> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn record_two_factor_failure(
        &self,
        _id: &ba::SchemaValue<String>,
        _max_attempts: i64,
        _locked_until: &(dyn Fn() -> AuthResult<ba::FieldDate> + Send + Sync),
    ) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn reset_two_factor_failures(
        &self,
        _id: &ba::SchemaValue<String>,
        _locked_before: Option<ba::FieldDate>,
    ) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl ApiKeyStore for PgStore {
    async fn create_api_key(&self, _input: CreateApiKey) -> AuthResult<ApiKey> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_api_key_by_id(&self, _id: &str) -> AuthResult<Option<ApiKey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_api_key_by_hash(&self, _hash: &str) -> AuthResult<Option<ApiKey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn find_api_keys_by_reference_value(
        &self,
        _reference_id: &ba::FieldValue,
        _sort: Option<(&str, &str)>,
    ) -> AuthResult<Vec<ApiKey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn count_api_keys_by_reference_value(
        &self,
        _reference_id: &ba::FieldValue,
    ) -> AuthResult<u64> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_api_key(
        &self,
        _id: &ba::SchemaValue<String>,
        _update: UpdateApiKey,
    ) -> AuthResult<ApiKey> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_api_key(&self, _id: &ba::SchemaValue<String>) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_expired_api_keys_before(&self, _cutoff: ba::FieldDate) -> AuthResult<usize> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn write_api_key_usage(
        &self,
        _id: &ba::SchemaValue<String>,
        _write: ApiKeyUsageWrite,
    ) -> AuthResult<Option<ApiKey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl PasskeyStore for PgStore {
    async fn create_passkey(&self, _input: CreatePasskey) -> AuthResult<Passkey> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_passkey_by_id(&self, _id: &str) -> AuthResult<Option<Passkey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_passkey_by_credential_id_value(
        &self,
        _credential_id: &ba::FieldValue,
    ) -> AuthResult<Option<Passkey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_passkeys_by_user_value(
        &self,
        _user_id: &ba::FieldValue,
    ) -> AuthResult<Vec<Passkey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_passkey_authentication_optional(
        &self,
        _id: &ba::SchemaValue<String>,
        _update: UpdatePasskeyAuthentication,
    ) -> AuthResult<Option<Passkey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_passkey_optional(
        &self,
        _id: &ba::SchemaValue<String>,
        _update: UpdatePasskey,
    ) -> AuthResult<Option<Passkey>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_passkey(&self, _id: &str) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl DeviceCodeStore for PgStore {
    async fn create_device_code_record(
        &self,
        _fields: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_device_code_record(
        &self,
        _id: &ba::SchemaValue<String>,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_device_code_record(
        &self,
        _id: &ba::SchemaValue<String>,
        _fields: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn create_device_code(&self, _input: CreateDeviceCode) -> AuthResult<DeviceCode> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_device_code_by_device_code(
        &self,
        _device_code: &str,
    ) -> AuthResult<Option<DeviceCode>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_device_code_by_user_code(
        &self,
        _user_code: &str,
    ) -> AuthResult<Option<DeviceCode>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_device_code(
        &self,
        _id: &ba::SchemaValue<String>,
        _update: UpdateDeviceCode,
    ) -> AuthResult<DeviceCode> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_device_code_if_status(
        &self,
        _id: &ba::SchemaValue<String>,
        _current_status: &str,
        _update: UpdateDeviceCode,
    ) -> AuthResult<bool> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn claim_device_code(
        &self,
        _id: &ba::SchemaValue<String>,
        _user_id: &ba::SchemaValue<String>,
    ) -> AuthResult<bool> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn consume_device_code(
        &self,
        _expected: &DeviceCode,
        _ownership: &ba::DeviceCodeOwnership,
    ) -> AuthResult<Option<DeviceCode>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_device_code(&self, _id: &ba::SchemaValue<String>) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_device_code_if_status(
        &self,
        _id: &ba::SchemaValue<String>,
        _status: &str,
    ) -> AuthResult<bool> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl WalletStore for PgStore {
    async fn create_wallet_address_record(
        &self,
        _input: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_wallet_address_record(
        &self,
        _id: &ba::SchemaValue<String>,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_wallet_address_record(
        &self,
        _id: &ba::SchemaValue<String>,
        _input: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_wallet_address_record(&self, _id: &ba::SchemaValue<String>) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_wallet_address_value(
        &self,
        _address: &ba::FieldValue,
        _chain_id: Option<&ba::FieldValue>,
    ) -> AuthResult<Option<ba::WalletAddress>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl JwksStore for PgStore {
    async fn create_jwk_record(&self, _input: ba::FieldMap) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn get_jwk_record(
        &self,
        _id: &ba::SchemaValue<String>,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn update_jwk_record(
        &self,
        _id: &ba::SchemaValue<String>,
        _input: ba::FieldMap,
    ) -> AuthResult<Option<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn delete_jwk_record(&self, _id: &ba::SchemaValue<String>) -> AuthResult<()> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
    async fn list_jwk_records(&self) -> AuthResult<Vec<ba::FieldMap>> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

#[async_trait]
impl RateLimitStore for PgStore {
    async fn consume_rate_limit(
        &self,
        _key: &str,
        _rule: ba::middleware::EndpointRateLimit,
        _cleanup_window: f64,
    ) -> AuthResult<ba::middleware::RateLimitDecision> {
        Err(AuthError::config(
            "Capability disabled by Hyori auth adapter",
        ))
    }
}

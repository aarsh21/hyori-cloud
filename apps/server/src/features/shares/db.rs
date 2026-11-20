use crate::{
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::Id,
        files::{api::ShareRole, policy},
        shares::api::Share,
        users::api::UserIdentity,
    },
    wire::Nullable,
};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};

#[derive(Clone)]
pub(crate) struct ShareRecord {
    pub id: String,
    pub item_id: String,
    pub issuer_id: String,
    pub recipient_id: Option<String>,
    pub public: bool,
    pub role: ShareRole,
    pub token_digest: Option<String>,
    pub password_hash: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}
impl ShareRecord {
    pub fn from_row(row: &QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            item_id: row.try_get("", "item_id")?,
            issuer_id: row.try_get("", "issuer_id")?,
            recipient_id: row.try_get("", "recipient_id")?,
            public: row.try_get("", "public")?,
            role: policy::parse_role(&row.try_get::<String>("", "role")?)?,
            token_digest: row.try_get("", "token_digest")?,
            password_hash: row.try_get("", "password_hash")?,
            expires_at: row.try_get("", "expires_at")?,
            revoked_at: row.try_get("", "revoked_at")?,
        })
    }
    pub async fn get(tx: &DatabaseTransaction, id: &str) -> DomainResult<Self> {
        Self::from_row(
            &tx.query_one_raw(sql(
                "SELECT * FROM hyori_shares WHERE id=$1",
                vec![id.into()],
            ))
            .await?
            .ok_or_else(ApiError::not_found)?,
        )
    }
    pub async fn by_token(tx: &DatabaseTransaction, digest: &str) -> DomainResult<Self> {
        Self::from_row(&tx.query_one_raw(sql("SELECT s.* FROM hyori_shares s JOIN hyori_users u ON u.id=s.issuer_id AND u.status='active' WHERE s.token_digest=$1 AND s.public AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())", vec![digest.into()])).await?.ok_or_else(ApiError::denied)?)
    }
    pub fn project(&self, url: Option<String>, recipient: Option<UserIdentity>) -> Share {
        Share {
            id: Id(self.id.clone()),
            item_id: Id(self.item_id.clone()),
            role: self.role.clone(),
            recipient_id: Nullable(self.recipient_id.clone().map(Id)),
            recipient: Nullable(recipient),
            public: self.public,
            expires_at: Nullable(self.expires_at.map(|t| t.to_rfc3339())),
            password_protected: self.password_hash.is_some(),
            revoked_at: Nullable(self.revoked_at.map(|t| t.to_rfc3339())),
            url: Nullable(url),
        }
    }
    pub async fn insert(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        tx.execute_raw(sql("INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role,token_digest,password_hash,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", vec![self.id.clone().into(), self.item_id.clone().into(), self.issuer_id.clone().into(), self.recipient_id.clone().into(), self.public.into(), policy::role_name(&self.role).into(), self.token_digest.clone().into(), self.password_hash.clone().into(), self.expires_at.into(), self.revoked_at.into()])).await?;
        Ok(())
    }
}

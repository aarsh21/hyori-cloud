use crate::{
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Bytes, Id},
        uploads::api::{AcknowledgedPart, UploadState, UploadStatus},
    },
    wire::Nullable,
};
use chrono::{DateTime, Utc};
use hyori_storage::{CHUNK_SIZE, PartRef};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};

#[derive(Clone)]
pub(crate) struct Upload {
    pub id: String,
    pub editor_bound: bool,
    pub editor_superseded: bool,
    pub owner_id: String,
    pub uploader_id: Option<String>,
    pub grant_digests: Vec<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
    pub object_key: String,
    pub multipart_id: Option<String>,
    pub replace_id: Option<String>,
    pub replace_revision: Option<i64>,
    pub state: String,
    pub file_id: Option<String>,
    pub result: Option<serde_json::Value>,
    pub lease_token: Option<String>,
    pub lease_until: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    /// Consecutive clean cleanup observations; drives revisit backoff.
    pub clean_checks: i32,
}
impl Upload {
    pub fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            editor_bound: row.try_get("", "editor_bound")?,
            editor_superseded: row.try_get("", "editor_superseded")?,
            owner_id: row.try_get("", "owner_id")?,
            uploader_id: row.try_get("", "uploader_id")?,
            grant_digests: serde_json::from_value(row.try_get("", "grant_digests")?)
                .map_err(|_| ApiError::unavailable())?,
            parent_id: row.try_get("", "parent_id")?,
            name: row.try_get("", "name")?,
            size: row.try_get("", "size")?,
            mime_type: row.try_get("", "mime_type")?,
            object_key: row.try_get("", "object_key")?,
            multipart_id: row.try_get("", "multipart_id")?,
            replace_id: row.try_get("", "replace_id")?,
            replace_revision: row.try_get("", "replace_revision")?,
            state: row.try_get("", "state")?,
            file_id: row.try_get("", "file_id")?,
            result: row.try_get("", "result")?,
            lease_token: row.try_get("", "lease_token")?,
            lease_until: row.try_get("", "lease_until")?,
            expires_at: row.try_get("", "expires_at")?,
            clean_checks: row.try_get("", "clean_checks")?,
        })
    }
    pub async fn get(tx: &DatabaseTransaction, id: &str) -> DomainResult<Self> {
        Self::from_row(
            tx.query_one_raw(sql(
                "SELECT * FROM hyori_uploads WHERE id=$1 FOR UPDATE",
                vec![id.into()],
            ))
            .await?
            .ok_or_else(ApiError::not_found)?,
        )
    }
    pub fn total_parts(&self) -> u64 {
        (self.size as u64).div_ceil(CHUNK_SIZE).max(1)
    }
    pub fn part_size(&self, number: u32) -> Result<u64, ApiError> {
        if number == 0 || u64::from(number) > self.total_parts() {
            return Err(ApiError::invalid());
        }
        Ok((self.size as u64)
            .saturating_sub((u64::from(number) - 1) * CHUNK_SIZE)
            .min(CHUNK_SIZE))
    }
    pub async fn parts(&self, tx: &DatabaseTransaction) -> DomainResult<Vec<(PartRef, u64)>> {
        tx.query_all_raw(sql("SELECT part_number,size,etag FROM hyori_upload_parts WHERE upload_id=$1 ORDER BY part_number LIMIT 10000", vec![self.id.clone().into()])).await?.into_iter().map(|r| Ok((PartRef { part_number: r.try_get::<i32>("", "part_number")? as u16, etag: r.try_get("", "etag")? }, r.try_get::<i64>("", "size")? as u64))).collect()
    }
    pub async fn status(&self, tx: &DatabaseTransaction) -> DomainResult<UploadStatus> {
        Ok(UploadStatus {
            upload_id: Id(self.id.clone()),
            chunk_size: Bytes(CHUNK_SIZE),
            total_parts: Bytes(self.total_parts()),
            parts: self
                .parts(tx)
                .await?
                .into_iter()
                .map(|(part, size)| AcknowledgedPart {
                    part_number: u32::from(part.part_number),
                    size: Bytes(size),
                })
                .collect(),
            state: match self.state.as_str() {
                "complete" => UploadState::Complete,
                "aborted" => UploadState::Aborted,
                _ => UploadState::Uploading,
            },
            file_id: Nullable(self.file_id.clone().map(Id)),
        })
    }
    pub async fn abort(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        if self.state == "complete" {
            return Err(ApiError::conflict().into());
        }
        if self.state != "aborted" {
            tx.execute_raw(sql(
                "UPDATE hyori_users SET reserved_bytes=reserved_bytes-$2 WHERE id=$1",
                vec![self.owner_id.clone().into(), self.size.into()],
            ))
            .await?;
            tx.execute_raw(sql("UPDATE hyori_uploads SET state='aborted',reservation_held=false,lease_token=NULL,lease_until=NULL,cleanup_due=now(),clean_checks=0 WHERE id=$1", vec![self.id.clone().into()])).await?;
        }
        Ok(())
    }
}

//! Bounded replay outcomes and a conservative, durable retired-ID admission fence.
use crate::{
    db::{DomainResult, sql},
    error::ApiError,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};
use sha2::{Digest, Sha256};

const FENCE_BYTES: usize = 128 * 1024;
const FENCE_VERSION: i32 = 1;
const HASH_DOMAIN: &[u8] = b"hyori-editor-retired-save-id-v1\0";
struct RetiredIds(Vec<u8>);
impl RetiredIds {
    fn read(row: &QueryResult) -> DomainResult<Self> {
        let bytes: Vec<u8> = row.try_get("", "retired_ids")?;
        Self::checked(
            bytes,
            row.try_get("", "retired_ids_version")?,
            &row.try_get::<String>("", "retired_ids_sha256")?,
        )
        .map_err(Into::into)
    }
    fn checked(bytes: Vec<u8>, version: i32, checksum: &str) -> Result<Self, ApiError> {
        if version != FENCE_VERSION
            || bytes.len() != FENCE_BYTES
            || hex::encode(Sha256::digest(&bytes)) != checksum
        {
            return Err(ApiError::unavailable());
        }
        Ok(Self(bytes))
    }
    fn positions(id: &str) -> [usize; 7] {
        let mut hash = Sha256::new();
        hash.update(HASH_DOMAIN);
        hash.update(id.as_bytes());
        let hash = hash.finalize();
        std::array::from_fn(|index| {
            let offset = index * 4;
            u32::from_be_bytes([
                hash[offset],
                hash[offset + 1],
                hash[offset + 2],
                hash[offset + 3],
            ]) as usize
                % (FENCE_BYTES * 8)
        })
    }
    fn contains(&self, id: &str) -> bool {
        Self::positions(id)
            .iter()
            .all(|bit| self.0[bit / 8] & (1 << (bit % 8)) != 0)
    }
    fn retire(&mut self, id: &str) {
        for bit in Self::positions(id) {
            self.0[bit / 8] |= 1 << (bit % 8);
        }
    }
}
/// Only call after checking exact retained replay. No fence rewrite on admission.
pub(crate) async fn admit(
    tx: &DatabaseTransaction,
    session: &str,
    save_id: &str,
) -> DomainResult<()> {
    let row = tx.query_one_raw(sql(
        "SELECT retired_ids,retired_ids_version,retired_ids_sha256 FROM hyori_editor_sessions WHERE id=$1 FOR UPDATE",
        vec![session.into()],
    )).await?.ok_or_else(ApiError::not_found)?;
    if RetiredIds::read(&row)?.contains(save_id) {
        return Err(ApiError::conflict().into());
    }
    let rows = tx.query_all_raw(sql(
        "SELECT result IS NULL AS pending FROM hyori_editor_saves WHERE session_id=$1 LIMIT 256",
        vec![session.into()],
    )).await?;
    let mut pending = 0;
    for row in &rows {
        pending += usize::from(row.try_get::<bool>("", "pending")?);
    }
    // Ineligible completed results remain protected; never exceed the total metadata bound.
    if rows.len() >= 256 || pending >= 128 {
        return Err(ApiError::conflict().into());
    }
    Ok(())
}
pub(crate) async fn missing_save(
    tx: &DatabaseTransaction,
    session: &str,
    id: &str,
) -> DomainResult<ApiError> {
    let row = tx.query_one_raw(sql(
        "SELECT retired_ids,retired_ids_version,retired_ids_sha256 FROM hyori_editor_sessions WHERE id=$1",
        vec![session.into()],
    )).await?.ok_or_else(ApiError::not_found)?;
    Ok(if RetiredIds::read(&row)?.contains(id) {
        ApiError::conflict()
    } else {
        ApiError::not_found()
    })
}
/// Publication holds the session lock. Bit updates and deletions commit or roll back together.
pub(crate) async fn prune(tx: &DatabaseTransaction, session: &str) -> DomainResult<()> {
    let rows = tx.query_all_raw(sql(
        "SELECT save_id FROM (SELECT save_id,expected_revision,result,row_number() OVER (ORDER BY outcome_sequence DESC) AS rank FROM hyori_editor_saves WHERE session_id=$1 AND result IS NOT NULL) s WHERE rank>128 AND expected_revision<(SELECT revision FROM hyori_editor_sessions WHERE id=$1) AND (result->>'revision')::bigint<(SELECT revision FROM hyori_editor_sessions WHERE id=$1) ORDER BY rank LIMIT 128",
        vec![session.into()],
    )).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let row = tx.query_one_raw(sql(
        "SELECT retired_ids,retired_ids_version,retired_ids_sha256 FROM hyori_editor_sessions WHERE id=$1 FOR UPDATE",
        vec![session.into()],
    )).await?.ok_or_else(ApiError::not_found)?;
    let mut fence = RetiredIds::read(&row)?;
    let mut retired = Vec::new();
    for row in rows {
        let id: String = row.try_get("", "save_id")?;
        fence.retire(&id);
        retired.push(id);
    }
    let checksum = hex::encode(Sha256::digest(&fence.0));
    tx.execute_raw(sql(
        "UPDATE hyori_editor_sessions SET retired_ids=$2,retired_ids_sha256=$3 WHERE id=$1",
        vec![session.into(), fence.0.into(), checksum.into()],
    ))
    .await?;
    tx.execute_raw(sql(
        "DELETE FROM hyori_editor_saves WHERE session_id=$1 AND save_id IN (SELECT jsonb_array_elements_text($2::jsonb))",
        vec![session.into(), serde_json::json!(retired).into()],
    )).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retired_ids_survive_serialization_and_saturation_only_denies() {
        let mut fence = RetiredIds(vec![0; FENCE_BYTES]);
        for index in 0..10000 {
            fence.retire(&format!("id:{index}"));
        }
        let checksum = hex::encode(Sha256::digest(&fence.0));
        let restored = RetiredIds::checked(fence.0, FENCE_VERSION, &checksum).unwrap();
        for index in 0..10000 {
            assert!(restored.contains(&format!("id:{index}")));
        }
        let saturated = RetiredIds(vec![255; FENCE_BYTES]);
        assert!(saturated.contains("never-issued"));
        assert_eq!(
            RetiredIds::positions("id:1"),
            [1014439, 84264, 678036, 3785, 696458, 296572, 665435]
        );
    }
    #[test]
    fn malformed_fences_fail_closed() {
        let bytes = vec![0; FENCE_BYTES];
        let checksum = hex::encode(Sha256::digest(&bytes));
        assert!(RetiredIds::checked(bytes.clone(), 2, &checksum).is_err());
        assert!(RetiredIds::checked(vec![0; FENCE_BYTES - 1], 1, &checksum).is_err());
        let mut changed = bytes;
        changed[17] = 1;
        assert!(RetiredIds::checked(changed, 1, &checksum).is_err());
    }
}

//! Permanent deletion of trashed items and retained versions.
//!
//! Metadata, history, shares and quota change together in the caller's transaction, set-wise in
//! SQL. Storage is never touched here: each released immutable key becomes an exact-key tombstone
//! on its committed upload record, the same durable path automatic editor history uses. Upload
//! cleanup then removes it from RustFS after commit, once `history::collectible` agrees nothing
//! still refers to it, and keeps the record until removal succeeds.
use crate::{
    AppState,
    db::{self, DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::Bytes,
        files::api::{PermanentDeletion, TrashSummary},
    },
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, Value};
use std::sync::Arc;

/// Oldest trash roots handled by one retention pass; each may be a whole folder subtree.
const RETENTION_BATCH: i64 = 16;

/// Which trashed items go. Both scopes bind the owner as `$1`.
#[derive(Clone, Copy)]
pub(crate) enum Doomed<'a> {
    /// A trash root and everything beneath it, including entries trashed on their own earlier.
    Subtree(&'a str),
    /// Everything in the owner's Trash.
    Trash,
}
impl Doomed<'_> {
    fn scope(self, owner: &str) -> (&'static str, Vec<Value>) {
        match self {
            Self::Subtree(root) => (
                "owner_id=$1 AND trashed_at IS NOT NULL AND (id=$2 OR ancestor_ids @> jsonb_build_array($2::text))",
                vec![owner.into(), root.into()],
            ),
            Self::Trash => ("owner_id=$1 AND trashed_at IS NOT NULL", vec![owner.into()]),
        }
    }
}

/// `free` holds the doomed items' current and historical keys that no surviving item or version
/// (of any owner) still refers to. Deduplicated or restored keys referenced elsewhere stay.
/// Survival is tested per key through the object-key indexes with `scope` negated on that row
/// (unqualified columns bind to the innermost item), never as an anti-join against `doomed`.
fn free_keys(scope: &str) -> String {
    format!(
        "doomed AS MATERIALIZED (SELECT id,object_key,trash_root FROM hyori_items WHERE {scope}),
         keys AS MATERIALIZED (
            SELECT object_key FROM doomed WHERE object_key IS NOT NULL
            UNION SELECT v.object_key FROM hyori_versions v JOIN doomed d ON d.id=v.file_id),
         free AS MATERIALIZED (SELECT k.object_key FROM keys k
            WHERE NOT EXISTS (SELECT 1 FROM hyori_items i WHERE i.object_key=k.object_key AND NOT ({scope}))
              AND NOT EXISTS (SELECT 1 FROM hyori_versions v WHERE v.object_key=k.object_key
                AND NOT EXISTS (SELECT 1 FROM hyori_items f WHERE f.id=v.file_id AND {scope})))"
    )
}

/// Release `free` keys: drop their one distinct-object charge and turn each committed upload into
/// a fenced tombstone (a claimed cleanup must not certify the new deletion state).
const RELEASE: &str = "released AS (DELETE FROM hyori_objects o USING free f
        WHERE o.object_key=f.object_key AND o.owner_id=$1 RETURNING o.size),
     marked AS (UPDATE hyori_uploads u
        SET editor_superseded=true,cleanup_due=now(),cleanup_token=NULL,cleanup_until=NULL
        FROM free f WHERE u.object_key=f.object_key AND u.state='complete' RETURNING u.id)";

async fn charge_back(tx: &DatabaseTransaction, owner: &str, freed: i64) -> DomainResult<()> {
    if freed > 0 {
        tx.execute_raw(sql(
            "UPDATE hyori_users SET used_bytes=used_bytes-$2 WHERE id=$1",
            vec![owner.into(), freed.into()],
        ))
        .await?;
    }
    Ok(())
}

/// Caller has authorized the owner. Bounded memory: no item, key or share row enters the process.
/// Shares on removed items (and their link grants) are deleted with them.
pub(crate) async fn delete_trashed(
    tx: &DatabaseTransaction,
    owner: &str,
    doomed: Doomed<'_>,
) -> DomainResult<PermanentDeletion> {
    let (scope, values) = doomed.scope(owner);
    let freed: i64 = tx
        .query_one_raw(sql(
            &format!(
                "WITH {}, {RELEASE} SELECT coalesce((SELECT sum(size) FROM released),0)::bigint AS freed",
                free_keys(scope)
            ),
            values.clone(),
        ))
        .await?
        .ok_or_else(ApiError::unavailable)?
        .try_get("", "freed")?;
    charge_back(tx, owner, freed).await?;
    for statement in [
        "DELETE FROM hyori_photo_album_items WHERE file_id IN (SELECT id FROM hyori_items WHERE {scope})",
        "DELETE FROM hyori_shares WHERE item_id IN (SELECT id FROM hyori_items WHERE {scope})",
    ] {
        tx.execute_raw(sql(&statement.replace("{scope}", scope), values.clone()))
            .await?;
    }
    // One statement: parent references are checked at its end, and versions cascade.
    let items = tx
        .execute_raw(sql(
            &format!("DELETE FROM hyori_items WHERE {scope}"),
            values,
        ))
        .await?
        .rows_affected();
    Ok(PermanentDeletion {
        items: Bytes(items),
        freed_bytes: Bytes(freed as u64),
    })
}

/// What emptying Trash would remove and release, computed exactly as `delete_trashed` would.
pub(crate) async fn trash_summary(
    tx: &DatabaseTransaction,
    owner: &str,
) -> DomainResult<TrashSummary> {
    let (scope, values) = Doomed::Trash.scope(owner);
    let row = tx
        .query_one_raw(sql(
            &format!(
                "WITH {} SELECT (SELECT count(*) FROM doomed WHERE trash_root=id) AS items,
                    coalesce((SELECT sum(o.size) FROM hyori_objects o JOIN free f ON f.object_key=o.object_key
                        WHERE o.owner_id=$1),0)::bigint AS freed",
                free_keys(scope)
            ),
            values,
        ))
        .await?
        .ok_or_else(ApiError::unavailable)?;
    Ok(TrashSummary {
        items: Bytes(row.try_get::<i64>("", "items")? as u64),
        freed_bytes: Bytes(row.try_get::<i64>("", "freed")? as u64),
    })
}

/// Remove one retained version. Its key is released only when no item or other version uses it,
/// so a version identical to the current contents frees nothing.
pub(crate) async fn delete_version(
    tx: &DatabaseTransaction,
    owner: &str,
    file: &str,
    version: &str,
) -> DomainResult<PermanentDeletion> {
    let row = tx
        .query_one_raw(sql(
            &format!(
                "WITH target AS MATERIALIZED (SELECT id,object_key FROM hyori_versions
                    WHERE owner_id=$1 AND file_id=$2 AND id=$3),
                 free AS MATERIALIZED (SELECT t.object_key FROM target t
                    WHERE NOT EXISTS (SELECT 1 FROM hyori_items i WHERE i.object_key=t.object_key)
                      AND NOT EXISTS (SELECT 1 FROM hyori_versions v WHERE v.object_key=t.object_key AND v.id<>t.id)),
                 {RELEASE},
                 removed AS (DELETE FROM hyori_versions v USING target t WHERE v.id=t.id RETURNING 1)
                 SELECT (SELECT count(*) FROM removed) AS removed,
                    coalesce((SELECT sum(size) FROM released),0)::bigint AS freed"
            ),
            vec![owner.into(), file.into(), version.into()],
        ))
        .await?
        .ok_or_else(ApiError::unavailable)?;
    let removed: i64 = row.try_get("", "removed")?;
    if removed == 0 {
        return Err(ApiError::not_found().into());
    }
    let freed: i64 = row.try_get("", "freed")?;
    charge_back(tx, owner, freed).await?;
    Ok(PermanentDeletion {
        items: Bytes(removed as u64),
        freed_bytes: Bytes(freed as u64),
    })
}

/// One bounded, restart-safe trash retention pass for runtime maintenance. Permanently deletes up
/// to 16 of the oldest trash roots (with their subtrees) past `trash_retention_days`, skipping rows
/// another process holds, then prompts storage cleanup. Returns the number of items removed.
pub async fn purge_expired_trash(state: &Arc<AppState>) -> Result<u64, ApiError> {
    let days = i64::from(state.config.trash_retention_days);
    let removed = db::domain(&state.db, move |tx| {
        Box::pin(async move {
            let roots = tx
                .query_all_raw(sql(
                    "SELECT i.id,i.owner_id FROM hyori_items i
                     JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                     WHERE i.trashed_at IS NOT NULL AND i.trash_root=i.id
                       AND i.trashed_at<=now()-$1::bigint*interval '1 day'
                     ORDER BY i.trashed_at,i.id LIMIT $2
                     FOR UPDATE OF i SKIP LOCKED FOR KEY SHARE OF u SKIP LOCKED",
                    vec![days.into(), RETENTION_BATCH.into()],
                ))
                .await?;
            let mut removed = 0;
            for row in roots {
                let id: String = row.try_get("", "id")?;
                let owner: String = row.try_get("", "owner_id")?;
                // An earlier root in this batch may already have removed a nested one.
                removed += delete_trashed(tx, &owner, Doomed::Subtree(&id))
                    .await?
                    .items
                    .0;
            }
            Ok(removed)
        })
    })
    .await?;
    if removed > 0 {
        state.upload_cleanup.notify_one();
    }
    Ok(removed)
}

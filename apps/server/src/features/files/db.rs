use crate::{
    db::{DomainResult, sql},
    error::ApiError,
    features::files::api::{FileKind, ShareRole},
};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult};
use std::collections::HashMap;

/// One lookup for the already authorized folders on the page. Absent rows are empty folders.
pub(crate) async fn child_counts(
    tx: &DatabaseTransaction,
    folder_ids: Vec<&str>,
) -> DomainResult<HashMap<String, u64>> {
    if folder_ids.is_empty() {
        return Ok(HashMap::new());
    }
    tx.query_all_raw(sql(
        "SELECT parent_id, child_count FROM hyori_item_child_counts
         WHERE parent_id = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
        vec![serde_json::json!(folder_ids).into()],
    ))
    .await?
    .into_iter()
    .map(|row| {
        Ok((
            row.try_get("", "parent_id")?,
            row.try_get::<i64>("", "child_count")? as u64,
        ))
    })
    .collect()
}

/// Persistence-only metadata. Never serialize this into a product response.
#[derive(Clone, Debug)]
pub(crate) struct Item {
    /// Transaction-local policy projection, not persisted; populated by `policy::load_roles`.
    pub share_role: Option<ShareRole>,
    pub parent_readable: bool,
    pub id: String,
    pub owner_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: FileKind,
    pub size: i64,
    pub mime_type: String,
    pub object_key: Option<String>,
    pub uploaded_by: Option<String>,
    pub ancestor_ids: Vec<String>,
    pub revision: i64,
    pub trash_root: Option<String>,
    pub trashed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
impl Item {
    pub fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            share_role: None,
            parent_readable: false,
            id: row.try_get("", "id")?,
            owner_id: row.try_get("", "owner_id")?,
            parent_id: row.try_get("", "parent_id")?,
            name: row.try_get("", "name")?,
            kind: match row.try_get::<String>("", "kind")?.as_str() {
                "file" => FileKind::File,
                "folder" => FileKind::Folder,
                _ => return Err(ApiError::unavailable().into()),
            },
            size: row.try_get("", "size")?,
            mime_type: row.try_get("", "mime_type")?,
            object_key: row.try_get("", "object_key")?,
            uploaded_by: row.try_get("", "uploaded_by")?,
            ancestor_ids: serde_json::from_value(row.try_get("", "ancestor_ids")?)
                .map_err(|_| ApiError::unavailable())?,
            revision: row.try_get("", "revision")?,
            trash_root: row.try_get("", "trash_root")?,
            trashed_at: row.try_get("", "trashed_at")?,
            created_at: row.try_get("", "created_at")?,
            updated_at: row.try_get("", "updated_at")?,
        })
    }
    pub async fn get(tx: &DatabaseTransaction, id: &str) -> DomainResult<Self> {
        Self::from_row(
            tx.query_one_raw(sql(
                "SELECT * FROM hyori_items WHERE id=$1",
                vec![id.into()],
            ))
            .await?
            .ok_or_else(ApiError::not_found)?,
        )
    }
    pub async fn insert(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        tx.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key,uploaded_by,ancestor_ids,revision,trash_root,trashed_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", vec![self.id.clone().into(), self.owner_id.clone().into(), self.parent_id.clone().into(), self.name.clone().into(), (if self.kind == FileKind::File {"file"} else {"folder"}).into(), self.size.into(), self.mime_type.clone().into(), self.object_key.clone().into(), self.uploaded_by.clone().into(), serde_json::json!(self.ancestor_ids).into(), self.revision.into(), self.trash_root.clone().into(), self.trashed_at.into(), self.created_at.into(), self.updated_at.into()])).await?;
        Ok(())
    }
    pub async fn save(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        let changed = tx.execute_raw(sql("UPDATE hyori_items SET parent_id=$3,name=$4,size=$5,mime_type=$6,object_key=$7,ancestor_ids=$8,revision=$9,trash_root=$10,trashed_at=$11,updated_at=$12 WHERE id=$1 AND owner_id=$2", vec![self.id.clone().into(), self.owner_id.clone().into(), self.parent_id.clone().into(), self.name.clone().into(), self.size.into(), self.mime_type.clone().into(), self.object_key.clone().into(), serde_json::json!(self.ancestor_ids).into(), self.revision.into(), self.trash_root.clone().into(), self.trashed_at.into(), self.updated_at.into()])).await?;
        if changed.rows_affected() != 1 {
            return Err(ApiError::conflict().into());
        }
        Ok(())
    }
    // Subtree changes are set-based single statements: no descendant row enters the process and
    // the GIN ancestor index bounds each to its subtree, however large.
    fn subtree(&self) -> Vec<sea_orm::Value> {
        vec![self.owner_id.clone().into(), self.id.clone().into()]
    }
    /// Entries already trashed on their own keep their own trash root.
    pub async fn trash_descendants(
        &self,
        tx: &DatabaseTransaction,
        now: DateTime<Utc>,
    ) -> DomainResult<()> {
        let mut values = self.subtree();
        values.push(now.into());
        tx.execute_raw(sql("UPDATE hyori_items SET trashed_at=$3,trash_root=$2,revision=revision+1 WHERE owner_id=$1 AND ancestor_ids @> jsonb_build_array($2::text) AND trashed_at IS NULL", values)).await?;
        Ok(())
    }
    /// The partial unique index checks every restored name atomically, including conflicts within
    /// the restored group; a violation rolls back the whole operation.
    pub async fn restore_descendants(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        tx.execute_raw(sql("UPDATE hyori_items SET trashed_at=NULL,trash_root=NULL,revision=revision+1 WHERE owner_id=$1 AND ancestor_ids @> jsonb_build_array($2::text) AND trash_root=$2", self.subtree())).await?;
        Ok(())
    }
    /// Replace this item's old ancestry prefix in every descendant with `ancestors` (its new one).
    pub async fn move_descendants(
        &self,
        tx: &DatabaseTransaction,
        ancestors: &[String],
    ) -> DomainResult<()> {
        let depth: i32 = tx
            .query_one_raw(sql("SELECT coalesce(max(jsonb_array_length(ancestor_ids)),0)::int AS depth FROM hyori_items WHERE owner_id=$1 AND ancestor_ids @> jsonb_build_array($2::text)", self.subtree()))
            .await?
            .ok_or_else(ApiError::unavailable)?
            .try_get("", "depth")?;
        if depth as usize + ancestors.len() > 63 + self.ancestor_ids.len() {
            return Err(ApiError::invalid().into());
        }
        let mut values = self.subtree();
        values.push(serde_json::json!(ancestors).into());
        values.push((self.ancestor_ids.len() as i64).into());
        tx.execute_raw(sql("UPDATE hyori_items SET ancestor_ids=$3::jsonb || jsonb_path_query_array(ancestor_ids, ('$[' || $4::bigint::text || ' to last]')::jsonpath),revision=revision+1 WHERE owner_id=$1 AND ancestor_ids @> jsonb_build_array($2::text)", values)).await?;
        Ok(())
    }
}

pub(crate) struct Version {
    pub id: String,
    pub file_id: String,
    pub owner_id: String,
    pub object_key: String,
    pub size: i64,
    pub mime_type: String,
    pub created_at: DateTime<Utc>,
}
impl Version {
    pub fn from_row(row: QueryResult) -> DomainResult<Self> {
        Ok(Self {
            id: row.try_get("", "id")?,
            file_id: row.try_get("", "file_id")?,
            owner_id: row.try_get("", "owner_id")?,
            object_key: row.try_get("", "object_key")?,
            size: row.try_get("", "size")?,
            mime_type: row.try_get("", "mime_type")?,
            created_at: row.try_get("", "created_at")?,
        })
    }
    pub async fn get(tx: &DatabaseTransaction, id: &str, item: &Item) -> DomainResult<Self> {
        Self::from_row(
            tx.query_one_raw(sql(
                "SELECT * FROM hyori_versions WHERE id=$1 AND file_id=$2 AND owner_id=$3",
                vec![
                    id.into(),
                    item.id.clone().into(),
                    item.owner_id.clone().into(),
                ],
            ))
            .await?
            .ok_or_else(ApiError::not_found)?,
        )
    }
    pub async fn save(&self, tx: &DatabaseTransaction) -> DomainResult<()> {
        tx.execute_raw(sql("INSERT INTO hyori_versions(id,file_id,owner_id,object_key,size,mime_type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", vec![self.id.clone().into(), self.file_id.clone().into(), self.owner_id.clone().into(), self.object_key.clone().into(), self.size.into(), self.mime_type.clone().into(), self.created_at.into()])).await?;
        Ok(())
    }
}

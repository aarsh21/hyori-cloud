use crate::{
    AppState,
    auth::random_token,
    db::{self, DomainFuture, DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Bytes, Id},
        files::{
            api::*,
            db::{Item, Version},
            policy::{self, Action, ProductActor},
        },
    },
    rpc::RequestContext,
    wire::Nullable,
};
use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseTransaction, Statement};
use std::sync::Arc;

// Ordinary root browsing and library-wide searches retain this baseline until separately measured.
const BASELINE_LIST_SQL: &str = "SELECT i.* FROM hyori_items i
                 JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                 WHERE (i.owner_id=$1 OR EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(i.ancestor_ids || jsonb_build_array(i.id)) AS root(id)
                     JOIN hyori_shares s ON s.item_id=root.id AND s.revoked_at IS NULL
                     JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
                     WHERE (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb))))
                       AND (s.expires_at IS NULL OR s.expires_at>now())))
                   AND i.id>$3
                   AND (($4 AND i.owner_id=$1 AND i.trashed_at IS NOT NULL AND i.trash_root=i.id)
                        OR (NOT $4 AND i.trashed_at IS NULL))
                   AND (NOT $5 OR i.owner_id IS DISTINCT FROM $1)
                   AND ($4 OR CASE
                        WHEN $5 AND $6::text IS NULL AND $7=''
                            THEN EXISTS (SELECT 1 FROM hyori_shares s
                                JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
                                WHERE s.item_id=i.id AND s.revoked_at IS NULL
                                  AND (s.expires_at IS NULL OR s.expires_at>now())
                                  AND (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb)))))
                        WHEN $6::text IS NOT NULL OR $7=''
                            THEN i.parent_id IS NOT DISTINCT FROM $6
                        ELSE true END)
                   AND ($7='' OR strpos(lower(i.name),$7)>0)
                   AND ($8='' OR i.kind=$8 OR i.mime_type=$8 OR starts_with(i.mime_type,$8||'/'))
                   AND ($9::timestamptz IS NULL OR i.updated_at >= $9)
                   AND ($10::timestamptz IS NULL OR i.updated_at <= $10)
                   AND ($11::bigint IS NULL OR i.size >= $11)
                   AND ($12::bigint IS NULL OR i.size <= $12)
                 ORDER BY i.id LIMIT $13";

fn listing_statement(
    input: &ListFiles,
    user_id: Option<&str>,
    public_shares: &[String],
    parent: Option<&str>,
    limit: u32,
) -> DomainResult<Statement> {
    let trash = input.view == Some(FilesView::Trash);
    let shared = input.view == Some(FilesView::Shared);
    let search = input.search.as_deref().unwrap_or_default().to_lowercase();
    let cursor = policy::cursor(input.cursor.as_ref().and_then(|c| c.0.as_deref()))?;
    let after = input.after.as_ref().map(|t| t.parse()).transpose()?;
    let before = input.before.as_ref().map(|t| t.parse()).transpose()?;
    let kind = input.r#type.as_deref().unwrap_or_default();
    let min_size = input.min_size.as_ref().map(|b| b.0 as i64);
    let max_size = input.max_size.as_ref().map(|b| b.0 as i64);
    if !trash && parent.is_none() && (!shared || !search.is_empty()) {
        return Ok(sql(
            BASELINE_LIST_SQL,
            vec![
                user_id.into(),
                serde_json::json!(public_shares).into(),
                cursor.into(),
                trash.into(),
                shared.into(),
                parent.into(),
                search.into(),
                kind.into(),
                after.into(),
                before.into(),
                min_size.into(),
                max_size.into(),
                i64::from(limit + 1).into(),
            ],
        ));
    }

    // Bind only used values: sparse experiment PREPARE slots cannot be inferred by SQLx.
    let mut values = vec![];
    let mut bind = |value| {
        values.push(value);
        format!("${}", values.len())
    };
    let actor = bind(user_id.into());
    let cursor = bind(cursor.into());
    let shared_roots = !trash && parent.is_none();
    let mut predicates = if shared_roots {
        vec![]
    } else {
        vec![format!("i.id>{cursor}")]
    };
    if trash {
        predicates.extend([
            "i.trashed_at IS NOT NULL".into(),
            "i.trash_root=i.id".into(),
        ]);
    } else {
        predicates.push("i.trashed_at IS NULL".into());
    }
    if !search.is_empty() {
        let search = bind(search.into());
        predicates.push(format!("strpos(lower(i.name),{search})>0"));
    }
    if !kind.is_empty() {
        let kind = bind(kind.into());
        predicates.push(format!(
            "(i.kind={kind} OR i.mime_type={kind} OR starts_with(i.mime_type,{kind}||'/'))"
        ));
    }
    for (predicate, value) in [
        ("i.updated_at >=", after.map(Into::into)),
        ("i.updated_at <=", before.map(Into::into)),
        ("i.size >=", min_size.map(Into::into)),
        ("i.size <=", max_size.map(Into::into)),
    ] {
        if let Some(value) = value {
            let parameter = bind(value);
            predicates.push(format!("{predicate} {parameter}"));
        }
    }
    let active_owner = "JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'";
    let query = if trash {
        let lookahead = bind(i64::from(limit + 1).into());
        format!(
            "SELECT i.* FROM hyori_items i {active_owner}
            WHERE i.owner_id={actor} AND {} ORDER BY i.id LIMIT {lookahead}",
            predicates.join(" AND ")
        )
    } else {
        let grants = bind(serde_json::json!(public_shares).into());
        if let Some(parent) = parent {
            let parent = bind(parent.into());
            predicates.push(format!("i.parent_id={parent}"));
            predicates.push(format!("(i.owner_id={actor} OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(i.ancestor_ids || jsonb_build_array(i.id)) AS root(id)
                JOIN hyori_shares s ON s.item_id=root.id AND s.revoked_at IS NULL
                JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
                WHERE (s.recipient_id={actor} OR (s.public AND s.id IN (SELECT jsonb_array_elements_text({grants}::jsonb))))
                  AND (s.expires_at IS NULL OR s.expires_at>now())))"));
            if shared {
                predicates.push(format!("i.owner_id IS DISTINCT FROM {actor}"));
            }
            let lookahead = bind(i64::from(limit + 1).into());
            format!(
                "SELECT i.* FROM hyori_items i {active_owner}
                WHERE {} ORDER BY i.id LIMIT {lookahead}",
                predicates.join(" AND ")
            )
        } else {
            // Keep the measured direct-root shape, including its materialization boundaries.
            // Deduplication precedes page limiting; no inherited descendants or grant limit.
            let lookahead = bind(i64::from(limit + 1).into());
            format!("WITH eligible AS MATERIALIZED (
                SELECT DISTINCT s.item_id FROM hyori_shares s
                JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
                WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
                  AND (s.recipient_id={actor} OR (s.public AND s.id IN (SELECT jsonb_array_elements_text({grants}::jsonb))))
              ), visible AS MATERIALIZED (
                SELECT id FROM ((WITH scope_ids AS MATERIALIZED (
                  SELECT i.id FROM hyori_items i {active_owner}
                  WHERE i.id=ANY(ARRAY(SELECT item_id FROM eligible)) AND i.owner_id IS DISTINCT FROM {actor} AND {}
                ) SELECT id FROM scope_ids WHERE id>{cursor} ORDER BY id LIMIT {lookahead})
                ) combined_ids ORDER BY id LIMIT {lookahead}
              ) SELECT i.* FROM visible v JOIN hyori_items i ON i.id=v.id ORDER BY i.id", predicates.join(" AND "))
        }
    };
    Ok(sql(&query, values))
}

#[cfg(test)]
#[path = "../../../tests/fixtures/listing_templates.rs"]
mod listing_tests;

pub(crate) struct FilesService {
    state: Arc<AppState>,
    context: RequestContext,
}
impl FilesService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            state: state.clone(),
            context,
        }
    }
    pub async fn run<T, F>(&self, operation: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: for<'a> Fn(&'a DatabaseTransaction, ProductActor) -> DomainFuture<'a, T>
            + Send
            + Sync
            + 'static,
    {
        let operation = Arc::new(operation);
        let context = self.context.clone();
        db::domain(&self.state.db, move |tx| {
            let operation = operation.clone();
            let context = context.clone();
            Box::pin(async move {
                let actor = policy::resolve_actor(tx, &context).await?;
                operation(tx, actor).await
            })
        })
        .await
    }
    pub async fn get(&self, input: ItemInput) -> Result<FileEntry, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                actor.require_access()?;
                let item = policy::authorize(tx, &actor, &input.id.0, Action::Read, false).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn preview(&self, input: DownloadInput) -> Result<Download, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let descriptor = authorized_content(
                    tx,
                    &actor,
                    &input.id.0,
                    input.version_id.as_ref().map(|id| id.0.as_str()),
                )
                .await?;
                if !super::preview::supported(&descriptor.mime_type) {
                    return Err(ApiError::invalid().into());
                }
                Ok(Download {
                    url: super::preview::preview_url(
                        &input.id.0,
                        input.version_id.as_ref().map(|id| id.0.as_str()),
                        descriptor.revision,
                    ),
                    name: crate::features::auth::api::Name(descriptor.name),
                    size: Bytes(descriptor.size as u64),
                    mime_type: descriptor.mime_type,
                })
            })
        })
        .await
    }
    pub async fn list(&self, input: ListFiles) -> Result<FileList, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                actor.require_access()?;
                let parent = input
                    .parent_id
                    .as_ref()
                    .and_then(|p| p.0.as_ref())
                    .map(|p| p.0.as_str());
                let folder = if let Some(parent) = &parent {
                    let folder = policy::authorize(tx, &actor, parent, Action::Read, false).await?;
                    if folder.kind != FileKind::Folder {
                        return Err(ApiError::invalid().into());
                    }
                    Some(folder)
                } else {
                    None
                };
                let trash = input.view == Some(FilesView::Trash);
                if trash {
                    actor.require_user()?;
                }
                let limit = input.limit.unwrap_or(100);
                if !(1..=100).contains(&limit) {
                    return Err(ApiError::invalid().into());
                }
                let rows = tx
                    .query_all_raw(listing_statement(
                        &input,
                        actor.user_id(),
                        actor.public_shares(),
                        parent,
                        limit,
                    )?)
                    .await?;
                let mut rows = rows
                    .into_iter()
                    .map(Item::from_row)
                    .collect::<DomainResult<Vec<_>>>()?;
                policy::load_roles(tx, &actor, &mut rows).await?;
                let next_cursor = if rows.len() > limit as usize {
                    Some(rows[limit as usize - 1].id.clone())
                } else {
                    None
                };
                let items = rows
                    .iter()
                    .take(limit as usize)
                    .map(|item| policy::project(item, &actor))
                    .collect();
                let mut breadcrumbs = vec![];
                if let Some(folder) = &folder {
                    let mut ancestors = tx
                        .query_all_raw(sql(
                            "SELECT i.* FROM hyori_items i
                     JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                     WHERE i.id IN (SELECT jsonb_array_elements_text($1::jsonb))
                       AND i.trashed_at IS NULL LIMIT 64",
                            vec![serde_json::json!(folder.ancestor_ids).into()],
                        ))
                        .await?
                        .into_iter()
                        .map(Item::from_row)
                        .collect::<DomainResult<Vec<_>>>()?;
                    policy::load_roles(tx, &actor, &mut ancestors).await?;
                    for id in &folder.ancestor_ids {
                        if let Some(item) = ancestors
                            .iter()
                            .find(|item| &item.id == id)
                            .filter(|item| policy::access(item, &actor).can_download)
                        {
                            breadcrumbs.push(Breadcrumb {
                                id: Id(item.id.clone()),
                                name: crate::features::auth::api::Name(item.name.clone()),
                            });
                        }
                    }
                    breadcrumbs.push(Breadcrumb {
                        id: Id(folder.id.clone()),
                        name: crate::features::auth::api::Name(folder.name.clone()),
                    });
                }
                Ok(FileList {
                    items,
                    breadcrumbs,
                    next_cursor: Nullable(next_cursor),
                    folder: Nullable(folder.map(|item| policy::project(&item, &actor))),
                })
            })
        })
        .await
    }
    pub async fn create_folder(&self, input: CreateFolder) -> Result<FileEntry, ApiError> {
        let name = policy::normalize_name(&input.name.0)?;
        self.run(move |tx, actor| {
            let input = input.clone();
            let name = name.clone();
            Box::pin(async move {
                let parent_id = input.parent_id.0.map(|p| p.0);
                let destination = policy::destination(tx, &actor, parent_id.as_deref()).await?;
                policy::available_name(
                    tx,
                    &destination.owner_id,
                    parent_id.as_deref(),
                    &name,
                    None,
                )
                .await?;
                let item = Item {
                    share_role: destination
                        .parent
                        .as_ref()
                        .and_then(|parent| parent.share_role.clone()),
                    id: random_token(),
                    owner_id: destination.owner_id,
                    parent_id,
                    name,
                    kind: FileKind::Folder,
                    size: 0,
                    mime_type: "inode/directory".into(),
                    object_key: None,
                    uploaded_by: actor.user_id().map(str::to_owned),
                    ancestor_ids: destination.ancestor_ids,
                    revision: 0,
                    trash_root: None,
                    trashed_at: None,
                    created_at: Utc::now(),
                    updated_at: Utc::now(),
                };
                item.insert(tx).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn rename(&self, input: RenameFile) -> Result<FileEntry, ApiError> {
        let name = policy::normalize_name(&input.name.0)?;
        self.run(move |tx, actor| {
            let input = input.clone();
            let name = name.clone();
            Box::pin(async move {
                let mut item =
                    policy::authorize(tx, &actor, &input.id.0, Action::Edit, false).await?;
                policy::available_name(
                    tx,
                    &item.owner_id,
                    item.parent_id.as_deref(),
                    &name,
                    Some(&item.id),
                )
                .await?;
                item.name = name;
                item.revision += 1;
                item.updated_at = Utc::now();
                item.save(tx).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn move_item(&self, input: MoveFile) -> Result<FileEntry, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let mut item =
                    policy::authorize(tx, &actor, &input.id.0, Action::Owner, false).await?;
                let parent_id = input.parent_id.0.map(|p| p.0);
                let destination = policy::destination(tx, &actor, parent_id.as_deref()).await?;
                if destination.owner_id != item.owner_id {
                    return Err(ApiError::denied().into());
                }
                if destination
                    .parent
                    .as_ref()
                    .is_some_and(|p| p.id == item.id || p.ancestor_ids.contains(&item.id))
                {
                    return Err(ApiError::invalid().into());
                }
                policy::available_name(
                    tx,
                    &item.owner_id,
                    parent_id.as_deref(),
                    &item.name,
                    Some(&item.id),
                )
                .await?;
                if item.kind == FileKind::Folder {
                    let mut changes = vec![];
                    for child in item.descendants(tx).await? {
                        let position = child
                            .ancestor_ids
                            .iter()
                            .position(|id| id == &item.id)
                            .ok_or_else(ApiError::unavailable)?;
                        let mut ancestors = destination.ancestor_ids.clone();
                        ancestors.extend_from_slice(&child.ancestor_ids[position..]);
                        if ancestors.len() > 63 {
                            return Err(ApiError::invalid().into());
                        }
                        changes
                            .push(serde_json::json!({"id": child.id, "ancestor_ids": ancestors}));
                    }
                    tx.execute_raw(sql(
                        "UPDATE hyori_items i SET ancestor_ids=c.ancestor_ids,revision=i.revision+1
                     FROM jsonb_to_recordset($1::jsonb) AS c(id text,ancestor_ids jsonb)
                     WHERE i.id=c.id",
                        vec![serde_json::json!(changes).into()],
                    ))
                    .await?;
                }
                item.parent_id = parent_id;
                item.ancestor_ids = destination.ancestor_ids;
                item.revision += 1;
                item.updated_at = Utc::now();
                item.save(tx).await?;
                policy::load_roles(tx, &actor, std::slice::from_mut(&mut item)).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn trash(&self, input: ItemInput) -> Result<FileEntry, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let mut item =
                    policy::authorize(tx, &actor, &input.id.0, Action::Owner, false).await?;
                let now = Utc::now();
                if item.kind == FileKind::Folder {
                    let ids: Vec<_> = item
                        .descendants(tx)
                        .await?
                        .into_iter()
                        .filter(|child| child.trashed_at.is_none())
                        .map(|child| child.id)
                        .collect();
                    tx.execute_raw(sql(
                        "UPDATE hyori_items SET trashed_at=$1,trash_root=$2,revision=revision+1
                     WHERE id IN (SELECT jsonb_array_elements_text($3::jsonb))",
                        vec![
                            now.into(),
                            item.id.clone().into(),
                            serde_json::json!(ids).into(),
                        ],
                    ))
                    .await?;
                }
                item.trashed_at = Some(now);
                item.trash_root = Some(item.id.clone());
                item.revision += 1;
                item.updated_at = now;
                item.save(tx).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn restore(&self, input: ItemInput) -> Result<FileEntry, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let mut item =
                    policy::authorize(tx, &actor, &input.id.0, Action::Owner, true).await?;
                if item.trashed_at.is_none() {
                    return Ok(policy::project(&item, &actor));
                }
                if item.trash_root.as_deref() != Some(item.id.as_str()) {
                    return Err(ApiError::conflict().into());
                }
                if let Some(parent) = &item.parent_id {
                    policy::authorize(tx, &actor, parent, Action::Owner, false).await?;
                }
                policy::available_name(
                    tx,
                    &item.owner_id,
                    item.parent_id.as_deref(),
                    &item.name,
                    Some(&item.id),
                )
                .await?;
                if item.kind == FileKind::Folder {
                    let ids: Vec<_> = item
                        .descendants(tx)
                        .await?
                        .into_iter()
                        .filter(|child| child.trash_root.as_deref() == Some(item.id.as_str()))
                        .map(|child| child.id)
                        .collect();
                    // The partial unique index checks every restored name atomically, including conflicts
                    // within the selected group; a violation rolls back the whole operation.
                    tx.execute_raw(sql(
                        "UPDATE hyori_items SET trashed_at=NULL,trash_root=NULL,revision=revision+1
                     WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))",
                        vec![serde_json::json!(ids).into()],
                    ))
                    .await?;
                }
                item.trashed_at = None;
                item.trash_root = None;
                item.revision += 1;
                item.updated_at = Utc::now();
                item.save(tx).await?;
                policy::load_roles(tx, &actor, std::slice::from_mut(&mut item)).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn versions(&self, input: ListVersions) -> Result<Versions, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let item = policy::authorize(tx, &actor, &input.id.0, Action::Owner, false).await?;
                let cursor = input.cursor.and_then(|c| c.0);
                let rows = tx
                    .query_all_raw(sql(
                        "SELECT * FROM hyori_versions WHERE file_id=$1 AND owner_id=$2 AND id>$3
                 ORDER BY id LIMIT 101",
                        vec![
                            item.id.into(),
                            item.owner_id.into(),
                            policy::cursor(cursor.as_deref())?.into(),
                        ],
                    ))
                    .await?
                    .into_iter()
                    .map(Version::from_row)
                    .collect::<DomainResult<Vec<_>>>()?;
                let next_cursor = if rows.len() > 100 {
                    Some(rows[99].id.clone())
                } else {
                    None
                };
                Ok(Versions {
                    items: rows
                        .into_iter()
                        .take(100)
                        .map(|v| FileVersion {
                            id: Id(v.id),
                            file_id: Id(v.file_id),
                            size: Bytes(v.size as u64),
                            created_at: v.created_at.to_rfc3339(),
                        })
                        .collect(),
                    next_cursor: Nullable(next_cursor),
                })
            })
        })
        .await
    }
    pub async fn restore_version(&self, input: RestoreVersion) -> Result<FileEntry, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let mut item =
                    policy::authorize(tx, &actor, &input.id.0, Action::Owner, false).await?;
                let version = Version::get(tx, &input.version_id.0, &item).await?;
                let current_key = item.object_key.clone().ok_or_else(ApiError::not_found)?;
                if item.kind != FileKind::File {
                    return Err(ApiError::not_found().into());
                }
                if version.object_key != current_key {
                    Version {
                        id: random_token(),
                        file_id: item.id.clone(),
                        owner_id: item.owner_id.clone(),
                        object_key: current_key,
                        size: item.size,
                        mime_type: item.mime_type.clone(),
                        created_at: Utc::now(),
                    }
                    .save(tx)
                    .await?;
                }
                // Both immutable references already count toward usage; do not charge reused bytes.
                item.object_key = Some(version.object_key);
                item.size = version.size;
                item.mime_type = version.mime_type;
                item.revision += 1;
                item.updated_at = Utc::now();
                item.save(tx).await?;
                Ok(policy::project(&item, &actor))
            })
        })
        .await
    }
    pub async fn download(&self, input: DownloadInput) -> Result<Download, ApiError> {
        self.run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let descriptor = authorized_content(
                    tx,
                    &actor,
                    &input.id.0,
                    input.version_id.as_ref().map(|id| id.0.as_str()),
                )
                .await?;
                Ok(Download {
                    url: content_url(
                        &input.id.0,
                        input.version_id.as_ref().map(|id| id.0.as_str()),
                        descriptor.revision,
                    ),
                    name: crate::features::auth::api::Name(descriptor.name),
                    size: Bytes(descriptor.size as u64),
                    mime_type: descriptor.mime_type,
                })
            })
        })
        .await
    }
}
pub(crate) fn content_url(id: &str, version: Option<&str>, revision: i64) -> String {
    let selection = version
        .map(|value| format!("version={value}"))
        .unwrap_or_else(|| format!("revision={revision}"));
    format!("/api/storage/files/{id}?{selection}")
}
/// Storage owner calls this in a fresh domain transaction for every binary request, then streams
/// after commit. No object-store effect can be retried with a metadata transaction.
pub struct ContentDescriptor {
    pub object_key: String,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
    pub revision: i64,
}
/// Resolve current session/link authority and an immutable object reference for a new binary GET.
/// The caller may stream only after this commits, and must never return `object_key` to the client.
/// A supplied revision conditions current-file selection; it never grants historical access.
/// Returns ordinary authorization/not-found errors, or conflict for a changed expected revision.
pub async fn read_content(
    state: &Arc<AppState>,
    context: RequestContext,
    input: DownloadInput,
    expected_revision: Option<i64>,
) -> Result<ContentDescriptor, ApiError> {
    FilesService::new(state, context)
        .run(move |tx, actor| {
            let input = input.clone();
            Box::pin(async move {
                let descriptor = authorized_content(
                    tx,
                    &actor,
                    &input.id.0,
                    input.version_id.as_ref().map(|id| id.0.as_str()),
                )
                .await?;
                if expected_revision.is_some_and(|revision| descriptor.revision != revision) {
                    return Err(ApiError::conflict().into());
                }
                Ok(descriptor)
            })
        })
        .await
}
pub(crate) async fn authorized_content(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    id: &str,
    version_id: Option<&str>,
) -> DomainResult<ContentDescriptor> {
    let item = policy::authorize(
        tx,
        actor,
        id,
        if version_id.is_some() {
            Action::Owner
        } else {
            Action::Read
        },
        false,
    )
    .await?;
    if item.kind != FileKind::File {
        return Err(ApiError::invalid().into());
    }
    let object_key = item.object_key.clone().ok_or_else(ApiError::not_found)?;
    let version = if let Some(id) = version_id {
        Some(Version::get(tx, id, &item).await?)
    } else {
        None
    };
    Ok(ContentDescriptor {
        object_key: version
            .as_ref()
            .map(|v| v.object_key.clone())
            .unwrap_or(object_key),
        name: item.name,
        size: version.as_ref().map(|v| v.size).unwrap_or(item.size),
        mime_type: version.map(|v| v.mime_type).unwrap_or(item.mime_type),
        revision: item.revision,
    })
}

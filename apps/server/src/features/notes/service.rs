use crate::{
    AppState,
    auth::random_token,
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Done, Id, Name},
        files::{
            api::{FileKind, ItemInput},
            db::Item,
            policy::{self, Action, ProductActor},
            service::FilesService,
        },
        notes::api::*,
    },
    rpc::RequestContext,
    wire::Nullable,
};
use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use std::sync::Arc;
use yrs::{Doc, ReadTxn, Transact, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim};

pub(crate) const MIME: &str = "application/vnd.hyori.note";

fn initial_state() -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = doc.transact_mut();
    let group = fragment.push_back(&mut tx, XmlElementPrelim::empty("blockGroup"));
    let block = group.push_back(&mut tx, XmlElementPrelim::empty("blockContainer"));
    block.insert_attribute(&mut tx, "id", random_token());
    let paragraph = block.push_back(&mut tx, XmlElementPrelim::empty("paragraph"));
    for (key, value) in [
        ("backgroundColor", "default"),
        ("textColor", "default"),
        ("textAlignment", "left"),
    ] {
        paragraph.insert_attribute(&mut tx, key, value);
    }
    // Both first writers must edit the same text node. Concurrently creating adjacent text
    // nodes makes y-prosemirror merge one away, outside the original writer's undo history.
    paragraph.push_back(&mut tx, XmlTextPrelim::new(""));
    tx.encode_state_as_update_v1(&Default::default())
}

/// A bounded, lossless native export of one committed cut, never a client's unsaved editor.
pub(crate) async fn export(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    id: &str,
) -> DomainResult<(String, Vec<u8>, String)> {
    let item = require_note(tx, actor, id, Action::Read).await?;
    let row = tx
        .query_one_raw(sql(
            "SELECT generation,sequence,state FROM hyori_collab_documents WHERE item_id=$1",
            vec![id.into()],
        ))
        .await?
        .ok_or_else(ApiError::not_found)?;
    let generation: String = row.try_get("", "generation")?;
    let sequence: i64 = row.try_get("", "sequence")?;
    let state: Vec<u8> = row.try_get("", "state")?;
    let fence = format!("{generation}-{sequence}-{}", item.revision);
    let bytes = serde_json::to_vec(&serde_json::json!({ "format": "hyori-note", "schemaVersion": 1, "name": item.name, "state": hex::encode(state) })).map_err(|_|ApiError::unavailable())?;
    Ok((format!("{}.hyori-note.json", item.name), bytes, fence))
}
pub(crate) async fn require_note(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    id: &str,
    action: Action,
) -> DomainResult<Item> {
    let item = policy::authorize(tx, actor, id, action, false).await?;
    if item.mime_type != MIME {
        return Err(ApiError::not_found().into());
    }
    Ok(item)
}
async fn project(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    item: &Item,
) -> DomainResult<Note> {
    let row = tx.query_one_raw(sql("SELECT d.generation,EXISTS(SELECT 1 FROM hyori_note_favorites f WHERE f.item_id=d.item_id AND f.user_id=$2) AS favorite FROM hyori_collab_documents d WHERE d.item_id=$1",vec![item.id.clone().into(),actor.user_id().into()])).await?.ok_or_else(ApiError::not_found)?;
    Ok(Note {
        file: policy::project(item, actor),
        generation: Id(row.try_get("", "generation")?),
        metadata_revision: item.revision.to_string(),
        favorite: row.try_get("", "favorite")?,
    })
}
pub(crate) struct NotesService {
    files: FilesService,
}
impl NotesService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            files: FilesService::new(state, context),
        }
    }
    pub async fn download(&self, id: String, fence: String) -> Result<(String, Vec<u8>), ApiError> {
        self.files
            .run(move |tx, actor| {
                let id = id.clone();
                let fence = fence.clone();
                Box::pin(async move {
                    let (name, bytes, current) = export(tx, &actor, &id).await?;
                    if current != fence {
                        return Err(ApiError::conflict().into());
                    }
                    Ok((name, bytes))
                })
            })
            .await
    }
    pub async fn get(&self, input: ItemInput) -> Result<Note, ApiError> {
        self.files
            .run(move |tx, actor| {
                let id = input.id.0.clone();
                Box::pin(async move {
                    let item = require_note(tx, &actor, &id, Action::Read).await?;
                    project(tx, &actor, &item).await
                })
            })
            .await
    }
    pub async fn list(&self, input: NoteListInput) -> Result<NoteList, ApiError> {
        self.files.run(move |tx,actor| { let input=input.clone(); Box::pin(async move {
            let user=actor.require_user()?;
            let eligible=policy::eligible_share_roots("$1","$2");
            let statement=format!("WITH eligible AS MATERIALIZED ({eligible}) SELECT i.*,d.generation,
                EXISTS(SELECT 1 FROM hyori_note_favorites f WHERE f.item_id=i.id AND f.user_id=$1) AS favorite
                FROM hyori_items i JOIN hyori_collab_documents d ON d.item_id=i.id
                JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'
                WHERE i.id>$3 AND strpos(lower(i.name),lower($4))>0
                AND (CASE WHEN $5 THEN i.trashed_at IS NOT NULL AND i.trash_root=i.id AND i.owner_id=$1
                    ELSE i.trashed_at IS NULL AND (i.owner_id=$1 OR i.id IN (SELECT item_id FROM eligible)
                        OR i.ancestor_ids ?| ARRAY(SELECT item_id FROM eligible)) END)
                AND (NOT $6 OR EXISTS(SELECT 1 FROM hyori_note_favorites f WHERE f.item_id=i.id AND f.user_id=$1))
                ORDER BY i.id LIMIT 101");
            let rows=tx.query_all_raw(sql(&statement,vec![user.into(),serde_json::json!(actor.public_shares()).into(),input.cursor.as_ref().map(|v|v.0.as_str()).unwrap_or("").into(),input.search.as_deref().unwrap_or("").into(),input.trash.into(),input.favorites.into()])).await?;
            let next_cursor=rows.get(100).and_then(|_|rows.get(99)).map(|r|r.try_get::<String>("","id")).transpose()?.map(Id);
            let mut items=Vec::new(); let mut extras=Vec::new();
            for row in rows.into_iter().take(100) { extras.push((row.try_get::<String>("","generation")?,row.try_get::<bool>("","favorite")?)); items.push(Item::from_row(row)?); }
            policy::load_roles(tx,&actor,&mut items).await?;
            Ok(NoteList {items:items.iter().zip(extras).map(|(i,(g,f))|Note {file:policy::project(i,&actor),generation:Id(g),metadata_revision:i.revision.to_string(),favorite:f}).collect(),next_cursor:Nullable(next_cursor)})
        }) }).await
    }
    pub async fn create(&self, input: CreateNote) -> Result<Note, ApiError> {
        let name = input
            .name
            .as_ref()
            .map(|name| policy::normalize_name(&name.0))
            .transpose()?;
        self.files.run(move |tx,actor| { let input=input.clone(); let name=name.clone(); Box::pin(async move {
            actor.require_user()?;
            let parent_id=input.parent_id.0.map(|v|v.0);
            let (owner_id,ancestor_ids)=if let Some(id)=&parent_id {
                let parent=require_note(tx,&actor,id,Action::Edit).await?;
                if parent.ancestor_ids.len()>=32 {return Err(ApiError::invalid().into());}
                let mut ancestors=parent.ancestor_ids; ancestors.push(parent.id);
                (parent.owner_id,ancestors)
            } else {(actor.require_user()?.to_owned(),vec![])};
            // Serialize allocation before the unique-name insert. The quota trigger changes
            // this row, so a concurrent serializable snapshot retries before choosing a name.
            tx.query_one_raw(sql("SELECT id FROM hyori_users WHERE id=$1 FOR NO KEY UPDATE",vec![owner_id.clone().into()])).await?;
            // The filtered/paginated library cannot allocate names. Choose a free default in
            // the same serializable transaction that inserts it; explicit names stay strict.
            let name = match name {
                Some(name) => name,
                None => tx.query_one_raw(sql(
                    "WITH siblings AS MATERIALIZED (
                        SELECT name FROM hyori_items WHERE owner_id=$1
                            AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL
                            AND starts_with(name,'Untitled note')
                    ), candidates AS (
                        SELECT n,CASE WHEN n=1 THEN 'Untitled note' ELSE 'Untitled note '||n::text END AS name
                        FROM generate_series(1,(SELECT count(*)+1 FROM siblings)) AS n
                    ) SELECT name FROM candidates c WHERE NOT EXISTS (
                        SELECT 1 FROM siblings s WHERE s.name=c.name) ORDER BY c.n LIMIT 1",
                    vec![owner_id.clone().into(),parent_id.clone().into()],
                )).await?.ok_or_else(ApiError::unavailable)?.try_get("","name")?,
            };
            policy::available_name(tx,&owner_id,parent_id.as_deref(),&name,None).await?;
            let state=initial_state();
            let mut item=Item {id:random_token(),owner_id,parent_id,name,kind:FileKind::File,size:state.len() as i64,mime_type:MIME.into(),object_key:None,uploaded_by:actor.user_id().map(str::to_owned),ancestor_ids,revision:0,share_role:None,parent_readable:false,trash_root:None,trashed_at:None,created_at:Utc::now(),updated_at:Utc::now()};
            item.insert(tx).await?;
            tx.execute_raw(sql("INSERT INTO hyori_collab_documents(item_id,owner_id,kind,generation,state) VALUES ($1,$2,'note',$3,$4)",vec![item.id.clone().into(),item.owner_id.clone().into(),random_token().into(),state.into()])).await?;
            policy::load_roles(tx,&actor,std::slice::from_mut(&mut item)).await?;
            project(tx,&actor,&item).await
        }) }).await
    }
    pub async fn rename(&self, input: RenameNote) -> Result<Note, ApiError> {
        let name = policy::normalize_name(&input.name.0)?;
        self.files
            .run(move |tx, actor| {
                let input = input.clone();
                let name = name.clone();
                Box::pin(async move {
                    let mut item = require_note(tx, &actor, &input.id.0, Action::Rename).await?;
                    if item.name != input.expected_name.0 {
                        return Err(ApiError::conflict().into());
                    }
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
                    project(tx, &actor, &item).await
                })
            })
            .await
    }
    pub async fn favorite(&self, input: FavoriteNote) -> Result<Done, ApiError> {
        self.files.run(move|tx,actor|{let input=input.clone();Box::pin(async move{
            let user=actor.require_user()?; require_note(tx,&actor,&input.id.0,Action::Read).await?;
            let statement=if input.favorite {"INSERT INTO hyori_note_favorites(user_id,item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING"} else {"DELETE FROM hyori_note_favorites WHERE user_id=$1 AND item_id=$2"};
            tx.execute_raw(sql(statement,vec![user.into(),input.id.0.into()])).await?;
            Ok(Done{success:true})
        })}).await
    }
    pub async fn history(&self, input: NoteHistoryInput) -> Result<NoteHistory, ApiError> {
        self.files.run(move|tx,actor|{let id=input.id.0.clone();let cursor=input.cursor.clone();Box::pin(async move{
            require_note(tx,&actor,&id,Action::Owner).await?;
            let rows=tx.query_all_raw(sql("SELECT id,name,created_at FROM hyori_collab_checkpoints WHERE item_id=$1 AND ($2::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM hyori_collab_checkpoints WHERE item_id=$1 AND id=$2)) ORDER BY created_at DESC,id DESC LIMIT 31",vec![id.into(),cursor.map(|v|v.0).into()])).await?;
            let next_cursor=rows.get(30).and_then(|_|rows.get(29)).map(|r|r.try_get::<String>("","id")).transpose()?.map(Id);
            Ok(NoteHistory{items:rows.into_iter().take(30).map(|r|Ok(NoteCheckpoint{id:Id(r.try_get("","id")?),name:Name(r.try_get("","name")?),created_at:r.try_get::<chrono::DateTime<Utc>>("","created_at")?.to_rfc3339()})).collect::<DomainResult<_>>()?,next_cursor:Nullable(next_cursor)})
        })}).await
    }
    pub async fn checkpoint(&self, input: ItemInput) -> Result<NoteCheckpoint, ApiError> {
        self.files
            .run(move |tx, actor| {
                let id = input.id.0.clone();
                Box::pin(async move {
                    let item = require_note(tx, &actor, &id, Action::Owner).await?;
                    checkpoint(tx, &item).await
                })
            })
            .await
    }
    pub async fn restore_checkpoint(&self, input: RestoreNoteCheckpoint) -> Result<Note, ApiError> {
        self.files.run(move|tx,actor|{let input=input.clone();Box::pin(async move{
            let mut item=require_note(tx,&actor,&input.id.0,Action::Owner).await?;
            let row=tx.query_one_raw(sql("SELECT state FROM hyori_collab_checkpoints WHERE id=$1 AND item_id=$2",vec![input.checkpoint_id.0.into(),item.id.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
            let state:Vec<u8>=row.try_get("","state")?;
            // Retain the head being replaced. Old/offline sessions are fenced by a new generation.
            checkpoint(tx,&item).await?;
            tx.execute_raw(sql("UPDATE hyori_collab_documents SET state=$2,generation=$3,sequence=sequence+1 WHERE item_id=$1",vec![item.id.clone().into(),state.clone().into(),random_token().into()])).await?;
            item.size=state.len() as i64; item.revision+=1; item.updated_at=Utc::now(); item.save(tx).await?;
            project(tx,&actor,&item).await
        })}).await
    }
}
async fn checkpoint(tx: &DatabaseTransaction, item: &Item) -> DomainResult<NoteCheckpoint> {
    // Serialize checkpoint capacity and restore against live edits, including across replicas.
    tx.query_one_raw(sql(
        "SELECT item_id FROM hyori_collab_documents WHERE item_id=$1 FOR UPDATE",
        vec![item.id.clone().into()],
    ))
    .await?;
    let id = random_token();
    let now = Utc::now();
    tx.execute_raw(sql("INSERT INTO hyori_collab_checkpoints(id,item_id,owner_id,name,state,created_at) SELECT $1,item_id,$2,$3,state,$4 FROM hyori_collab_documents WHERE item_id=$5",vec![id.clone().into(),item.owner_id.clone().into(),item.name.clone().into(),now.into(),item.id.clone().into()])).await?;
    Ok(NoteCheckpoint {
        id: Id(id),
        name: Name(item.name.clone()),
        created_at: now.to_rfc3339(),
    })
}

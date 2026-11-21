use crate::{
    AppState,
    auth::{digest, random_token},
    db::{DomainResult, sql},
    error::ApiError,
    features::{
        auth::api::{Done, Id},
        collaboration::api::*,
        files::{
            policy::{self, Action, ProductActor},
            service::FilesService,
        },
        notes::service::require_note,
    },
    rpc::RequestContext,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use yrs::{
    Any, Doc, Out, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlFragment, XmlOut,
    updates::decoder::Decode,
};

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PositionId {
    client: u32,
    clock: u32,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct RelativePosition {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    parent: Option<PositionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<PositionId>,
    #[serde(default)]
    assoc: i32,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    anchor: RelativePosition,
    head: RelativePosition,
}

fn principal(actor: &ProductActor) -> DomainResult<String> {
    actor.require_access()?;
    Ok(actor
        .user_id()
        .map(|id| format!("user:{id}"))
        .unwrap_or_else(|| format!("guest:{}", digest(&actor.public_shares().join(":")))))
}
async fn identity(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
) -> DomainResult<(String, String)> {
    let name = if let Some(id) = actor.user_id() {
        tx.query_one_raw(sql(
            "SELECT name FROM hyori_users WHERE id=$1",
            vec![id.into()],
        ))
        .await?
        .ok_or_else(ApiError::required)?
        .try_get("", "name")?
    } else {
        "Guest editor".to_owned()
    };
    let colors = ["#9f563a", "#4f7561", "#566b9f", "#8b5a8d", "#8a6b32"];
    let hash = Sha256::digest(principal(actor)?.as_bytes());
    Ok((name, colors[usize::from(hash[0]) % colors.len()].into()))
}
pub(crate) struct CollaborationService {
    files: FilesService,
    state: Arc<AppState>,
}
impl CollaborationService {
    pub fn new(state: &Arc<AppState>, context: RequestContext) -> Self {
        Self {
            files: FilesService::new(state, context),
            state: state.clone(),
        }
    }
    pub async fn open(&self, input: CollaborationOpen) -> Result<CollaborationDocument, ApiError> {
        if input.schema_version != 1
            || input
                .client_id
                .parse::<u64>()
                .map_or(true, |v| v > 9_007_199_254_740_991)
        {
            return Err(ApiError::invalid());
        }
        let _queued = self.state.collaboration_locks.lock(Some(&input.id.0)).await;
        self.files.run(move|tx,actor|{let input=input.clone();Box::pin(async move{
            let item=require_note(tx,&actor,&input.id.0,Action::Read).await?;
            let principal=principal(&actor)?;
            // A document row is the coordinator; no in-memory room can outlive or bypass its fence.
            let row=tx.query_one_raw(sql("SELECT * FROM hyori_collab_documents WHERE item_id=$1 FOR UPDATE",vec![item.id.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
            tx.execute_raw(sql("DELETE FROM hyori_collab_sessions WHERE id IN (SELECT id FROM hyori_collab_sessions WHERE expires_at<=now() OR seen_at<now()-interval '2 minutes' ORDER BY seen_at LIMIT 128)",vec![])).await?;
            let counts=tx.query_one_raw(sql("SELECT count(*) AS count,count(*) FILTER (WHERE item_id=$2 AND starts_with(principal,'guest:')) AS guests FROM hyori_collab_sessions WHERE principal=$1 OR item_id=$2",vec![principal.clone().into(),item.id.clone().into()])).await?.ok_or_else(ApiError::unavailable)?;
            // Aggregate unsigned leases across every link, leaving four places for accounts.
            // The resolved actor, not the presence of a public cookie, determines admission.
            if counts.try_get::<i64>("","count")?>=16 || (actor.user_id().is_none() && counts.try_get::<i64>("","guests")?>=12){return Err(ApiError::limited().into());}
            let session_id=random_token();
            tx.execute_raw(sql("INSERT INTO hyori_collab_sessions(id,item_id,principal,client_id) VALUES($1,$2,$3,$4)",vec![session_id.clone().into(),item.id.clone().into(),principal.into(),input.client_id.into()])).await?;
            let (name,color)=identity(tx,&actor).await?;
            Ok(CollaborationDocument{session_id:Id(session_id),generation:Id(row.try_get("","generation")?),schema_version:1,state:hex::encode(row.try_get::<Vec<u8>>("","state")?),sequence:row.try_get::<i64>("","sequence")?.to_string(),writable:policy::access(&item,&actor).can_edit,name,color})
        })}).await
    }
    pub async fn sync(&self, input: CollaborationSync) -> Result<CollaborationReceipt, ApiError> {
        let vector = hex::decode(&input.vector).map_err(|_| ApiError::invalid())?;
        let vector = StateVector::decode_v1(&vector).map_err(|_| ApiError::invalid())?;
        let bytes = hex::decode(&input.update).map_err(|_| ApiError::invalid())?;
        if bytes.len() > 96 * 1024 || input.presence.len() > 4096 {
            return Err(ApiError::invalid());
        }
        let presence: serde_json::Value =
            serde_json::from_str(&input.presence).map_err(|_| ApiError::invalid())?;
        // Only relative selections travel from the client. Display identity is always server-owned.
        let cursor: Option<Cursor> = serde_json::from_value(
            presence
                .get("cursor")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        )
        .map_err(|_| ApiError::invalid())?;
        if cursor.as_ref().is_some_and(|c| {
            [&c.anchor, &c.head].into_iter().any(|p| {
                p.tname.as_deref().is_some_and(|name| name != "prosemirror")
                    || !(-1..=1).contains(&p.assoc)
            })
        }) {
            return Err(ApiError::invalid());
        }
        let cursor = serde_json::to_value(cursor).map_err(|_| ApiError::invalid())?;
        // This lookup only chooses a queue: it grants no authority. Resolve the current session,
        // actor, note permissions and generation again inside the serializable transaction.
        let id: String = self
            .state
            .db
            .query_one_raw(sql(
                "SELECT item_id FROM hyori_collab_sessions WHERE id=$1",
                vec![input.session_id.0.clone().into()],
            ))
            .await?
            .ok_or_else(ApiError::required)?
            .try_get("", "item_id")?;
        let _queued = self.state.collaboration_locks.lock(Some(&id)).await;
        self.files.run(move|tx,actor|{let input=input.clone();let bytes=bytes.clone();let vector=vector.clone();let cursor=cursor.clone();Box::pin(async move{
            let row=tx.query_one_raw(sql("SELECT item_id,client_id,presence,seen_at<now()-interval '3 seconds' AS heartbeat_due FROM hyori_collab_sessions WHERE id=$1 AND principal=$2 AND expires_at>now()",vec![input.session_id.0.clone().into(),principal(&actor)?.into()])).await?.ok_or_else(ApiError::required)?;
            let id:String=row.try_get("","item_id")?;
            let item=require_note(tx,&actor,&id,Action::Read).await?;
            let writable=policy::access(&item,&actor).can_edit;
            if !bytes.is_empty()&&!writable{return Err(ApiError::denied().into());}
            let statement=if bytes.is_empty(){"SELECT state,sequence,generation FROM hyori_collab_documents WHERE item_id=$1"}else{"SELECT state,sequence,generation FROM hyori_collab_documents WHERE item_id=$1 FOR UPDATE"};
            let doc=tx.query_one_raw(sql(statement,vec![id.clone().into()])).await?.ok_or_else(ApiError::not_found)?;
            if doc.try_get::<String>("","generation")?!=input.generation.0{return Err(ApiError::conflict().into());}
            let old:Vec<u8>=doc.try_get("","state")?;
            let old_for_merge=old.clone();let bytes_for_merge=bytes.clone();
            // Bounded CRDT validation stays off async executor threads. Only isolated candidate
            // state is mutated; a rejected or dependency-incomplete update never touches the head.
            let (state,delta)=tokio::task::spawn_blocking(move||merge(&old_for_merge,&bytes_for_merge,&vector)).await.map_err(|_|ApiError::invalid())??;
            let mut sequence:i64=doc.try_get("","sequence")?;
            if state!=old{
                sequence+=1;
                tx.execute_raw(sql("UPDATE hyori_collab_documents SET state=$2,sequence=$3 WHERE item_id=$1",vec![id.clone().into(),state.clone().into(),sequence.into()])).await?;
                tx.execute_raw(sql("UPDATE hyori_items SET size=$2,updated_at=now() WHERE id=$1",vec![id.clone().into(),(state.len() as i64).into()])).await?;
            }
            let (name,color)=identity(tx,&actor).await?;
            let presence=serde_json::json!({"user":{"name":name,"color":color},"cursor":cursor}).to_string();
            // An unchanged poll is read-only until the three-second heartbeat is due. Cursor
            // changes still publish immediately. Closing pages leave explicitly; the eight-second
            // peer fence only drops tabs that vanished without saying so, and the two-minute idle
            // fence frees their leases.
            if row.try_get::<bool>("","heartbeat_due")? || row.try_get::<String>("","presence")?!=presence {
                tx.execute_raw(sql("UPDATE hyori_collab_sessions SET presence=$2,seen_at=now(),expires_at=now()+interval '12 hours' WHERE id=$1",vec![input.session_id.0.clone().into(),presence.into()])).await?;
            }
            let peers=tx.query_all_raw(sql("SELECT client_id,presence FROM hyori_collab_sessions WHERE item_id=$1 AND id<>$2 AND presence<>'{}' AND seen_at>now()-interval '8 seconds' AND expires_at>now() ORDER BY id LIMIT 16",vec![id.into(),input.session_id.0.into()])).await?.into_iter().map(|r|Ok(CollaborationPeer{client_id:r.try_get("","client_id")?,presence:r.try_get("","presence")?})).collect::<DomainResult<Vec<_>>>()?;
            // FilesService::run commits before exposing this receipt to HTTP or another client.
            Ok(CollaborationReceipt{sequence:sequence.to_string(),update:hex::encode(delta),acknowledged:input.update,writable,peers})
        })}).await
    }
    pub async fn close(&self, input: CollaborationClose) -> Result<Done, ApiError> {
        self.files
            .run(move |tx, actor| {
                let id = input.session_id.0.clone();
                Box::pin(async move {
                    tx.execute_raw(sql(
                        "DELETE FROM hyori_collab_sessions WHERE id=$1 AND principal=$2",
                        vec![id.into(), principal(&actor)?.into()],
                    ))
                    .await?;
                    Ok(Done { success: true })
                })
            })
            .await
    }
}
fn valid_attribute(key: &str, value: &Any) -> bool {
    match (key, value) {
        ("id" | "language", Any::String(s)) => s.len() <= 128 && !s.chars().any(char::is_control),
        ("textColor" | "backgroundColor" | "stringValue", Any::String(s)) => {
            s.len() <= 64
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "#(),.% -".contains(c))
        }
        ("textAlignment", Any::String(s)) => {
            ["left", "right", "center", "justify"].contains(&s.as_ref())
        }
        ("checked" | "isToggleable", Any::Bool(_)) => true,
        ("level", Any::Number(n)) => (1.0..=6.0).contains(n) && n.fract() == 0.0,
        ("start" | "colspan" | "rowspan", Any::Number(n)) => {
            (1.0..=1000.0).contains(n) && n.fract() == 0.0
        }
        ("start" | "colwidth", Any::Null | Any::Undefined) => true,
        ("colwidth", Any::Array(widths)) => {
            widths.len() <= 100
                && widths
                    .iter()
                    .all(|v| matches!(v, Any::Number(n) if (0.0..=10000.0).contains(n)))
        }
        _ => false,
    }
}

fn valid_mark(key: &str, value: &Any) -> bool {
    let Any::Map(attrs) = value else {
        return false;
    };
    match key {
        "bold" | "italic" | "underline" | "strike" | "code" => attrs.is_empty(),
        "textColor" | "backgroundColor" => {
            attrs.len() == 1
                && attrs
                    .iter()
                    .all(|(k, v)| k == "stringValue" && valid_attribute(k, v))
        }
        "link" => {
            attrs.iter().all(|(k, v)| match (k.as_str(), v) {
                ("href", Any::String(s)) => {
                    s.len() <= 4096
                        && url::Url::parse(s).is_ok_and(|u| {
                            matches!(u.scheme(), "https" | "http" | "mailto" | "tel")
                        })
                }
                ("target", Any::String(s)) => ["_blank", "_self"].contains(&s.as_ref()),
                ("rel" | "class", Any::String(s)) => {
                    s.len() <= 128
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || " -_".contains(c))
                }
                ("target" | "rel" | "class", Any::Null) => true,
                _ => false,
            }) && attrs.contains_key("href")
        }
        _ => false,
    }
}

fn merge(old: &[u8], update: &[u8], vector: &StateVector) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let doc = Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Utf16,
        ..Default::default()
    });
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = doc.transact_mut();
    tx.apply_update(Update::decode_v1(old).map_err(|_| ApiError::invalid())?)
        .map_err(|_| ApiError::invalid())?;
    if !update.is_empty() {
        tx.apply_update(Update::decode_v1(update).map_err(|_| ApiError::invalid())?)
            .map_err(|_| ApiError::invalid())?;
    }
    if tx.has_missing_updates() || tx.root_refs().any(|(name, _)| name != "prosemirror") {
        return Err(ApiError::invalid());
    }
    let mut pending: Vec<_> = fragment.children(&tx).map(|node| (node, 0)).collect();
    let mut count = 0;
    while let Some((node, depth)) = pending.pop() {
        count += 1;
        if depth > 64 || count > 20000 {
            return Err(ApiError::invalid());
        }
        match node {
            XmlOut::Element(e) => {
                if ![
                    "blockGroup",
                    "blockContainer",
                    "paragraph",
                    "heading",
                    "bulletListItem",
                    "numberedListItem",
                    "checkListItem",
                    "quote",
                    "codeBlock",
                    "table",
                    "tableRow",
                    "tableCell",
                    "tableHeader",
                    "tableParagraph",
                    "hardBreak",
                    "divider",
                    "toggleListItem",
                ]
                .contains(&e.tag().as_ref())
                {
                    return Err(ApiError::invalid());
                }
                if e.attributes(&tx).any(|(key, value)| !matches!(value, Out::Any(value) if valid_attribute(key, &value))) {
                    return Err(ApiError::invalid());
                }
                pending.extend(e.children(&tx).map(|n| (n, depth + 1)));
            }
            XmlOut::Text(text) => {
                if text.attributes(&tx).next().is_some()
                    || text.diff(&tx, |_| ()).iter().any(|span| {
                        !matches!(span.insert, Out::Any(Any::String(_)))
                            || span
                                .attributes
                                .as_ref()
                                .is_some_and(|attrs| attrs.iter().any(|(k, v)| !valid_mark(k, v)))
                    })
                {
                    return Err(ApiError::invalid());
                }
            }
            XmlOut::Fragment(f) => pending.extend(f.children(&tx).map(|n| (n, depth + 1))),
        }
    }
    let state = tx.encode_state_as_update_v1(&StateVector::default());
    if state.len() > 1024 * 1024 {
        return Err(ApiError::invalid());
    }
    Ok((state, tx.encode_diff_v1(vector)))
}

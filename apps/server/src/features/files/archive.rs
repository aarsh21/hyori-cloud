use super::{
    api::{FileKind, FolderDownload},
    db::Item,
    policy::{self, Action, ProductActor},
    service::FilesService,
};
use crate::{
    AppState,
    db::{DomainResult, sql},
    error::{ApiError, ErrorCode},
    features::{
        notes::service::NotesService,
        uploads::http::{encoded_filename, stream_download},
    },
    rpc::{RequestContext, validate_origin},
};
use axum::{
    body::Body,
    extract::{Path, State},
    http::Request,
    response::Response,
};
use futures_util::{StreamExt, stream};
use hyori_storage::{Bytes, StorageError, StorageStream};
use sea_orm::{ConnectionTrait, DatabaseTransaction};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    io::{self, BufWriter, Write},
    sync::Arc,
};
use tokio::{runtime::Handle, sync::mpsc};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const ZIP_MIME: &str = "application/zip";
const MAX_ENTRIES: usize = 10_000;
const MAX_PATH: usize = 4_096;
const MAX_PATH_BYTES: usize = 4 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

fn too_large() -> ApiError {
    ApiError::new(
        ErrorCode::ArchiveTooLarge,
        &format!(
            "Folder ZIPs can contain at most {MAX_ENTRIES} files and folders (including the root), {MAX_PATH} bytes per path, and {MAX_PATH_BYTES} bytes of paths in total. Download smaller subfolders instead."
        ),
    )
}

async fn authorize_folder(
    tx: &DatabaseTransaction,
    actor: &ProductActor,
    id: &str,
) -> DomainResult<Item> {
    actor.require_access()?;
    let folder = policy::authorize(tx, actor, id, Action::Read, false).await?;
    if folder.kind != FileKind::Folder {
        return Err(ApiError::not_found().into());
    }
    Ok(folder)
}

pub(crate) async fn describe(
    state: &Arc<AppState>,
    context: RequestContext,
    id: String,
) -> Result<FolderDownload, ApiError> {
    FilesService::new(state, context)
        .run(move |tx, actor| {
            let id = id.clone();
            Box::pin(async move {
                let folder = authorize_folder(tx, &actor, &id).await?;
                Ok(FolderDownload {
                    url: format!("/api/storage/folders/{id}"),
                    name: format!("{}.zip", segment(&folder.name)),
                    mime_type: ZIP_MIME.into(),
                })
            })
        })
        .await
}

enum Content {
    Directory,
    Object { key: String, size: u64 },
    Note { id: String, fence: String },
}

/// Escape ZIP separators, Windows-invalid characters (including drive/stream colons), and
/// trailing dots. Escape '%' too, so a literal name cannot collide with an escaped name.
fn segment(name: &str) -> String {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    let tail = name.trim_end_matches(['.', ' ']).len();
    let mut result = String::new();
    for (offset, char) in name.char_indices() {
        if (device && offset == 0)
            || offset >= tail
            || char.is_ascii_control()
            || "%/\\:<>\"|?*".contains(char)
        {
            use std::fmt::Write as _;
            write!(&mut result, "%{:02X}", char as u32).expect("writing to a string cannot fail");
        } else {
            result.push(char);
        }
    }
    result
}

/// Snapshot the subtree in the same transaction that authorizes its root. Folder grants inherit
/// to all active descendants; the owner and parent predicates keep traversal inside that tree.
/// Stop after one lookahead before sorting or joining Notes metadata, never read object bytes here.
async fn manifest(
    tx: &DatabaseTransaction,
    root: Item,
) -> DomainResult<(String, Vec<(String, Content)>)> {
    let rows = tx.query_all_raw(sql(
        "WITH RECURSIVE tree(id, parent_id, name, kind, depth, size, object_key, mime_type, revision) AS (
           SELECT id, parent_id, name, kind, 0, size, object_key, mime_type, revision FROM hyori_items WHERE id=$1
           UNION ALL
           SELECT c.id, c.parent_id, c.name, c.kind, t.depth+1, c.size, c.object_key, c.mime_type, c.revision
           FROM tree t CROSS JOIN LATERAL (
             SELECT * FROM hyori_items WHERE parent_id=t.id AND owner_id=$2 AND trashed_at IS NULL OFFSET 0
           ) c WHERE (t.kind='folder' OR t.mime_type=$4) AND t.depth<63
         ), bounded AS MATERIALIZED (SELECT * FROM tree LIMIT $3)
         SELECT b.*, d.generation || '-' || d.sequence || '-' || b.revision AS note_fence
         FROM bounded b LEFT JOIN hyori_collab_documents d ON d.item_id=b.id AND b.mime_type=$4
         ORDER BY b.depth,b.id",
        vec![root.id.clone().into(), root.owner_id.into(), ((MAX_ENTRIES + 1) as i64).into(), crate::features::notes::service::MIME.into()],
    )).await?;
    if rows.len() > MAX_ENTRIES {
        return Err(too_large().into());
    }
    let mut names = HashMap::<String, HashSet<String>>::new();
    let mut parents = HashSet::new();
    let rows = rows
        .iter()
        .map(|row| {
            let id: String = row.try_get("", "id")?;
            let parent: Option<String> = row.try_get("", "parent_id")?;
            let name = segment(&row.try_get::<String>("", "name")?);
            let content = if row.try_get::<String>("", "kind")? == "folder" {
                Content::Directory
            } else if row.try_get::<String>("", "mime_type")?
                == crate::features::notes::service::MIME
            {
                Content::Note {
                    id: id.clone(),
                    fence: row.try_get("", "note_fence")?,
                }
            } else {
                Content::Object {
                    key: row
                        .try_get::<Option<String>>("", "object_key")?
                        .ok_or_else(ApiError::unavailable)?,
                    size: row.try_get::<i64>("", "size")? as u64,
                }
            };
            if let Some(parent) = &parent {
                parents.insert(parent.clone());
                names
                    .entry(parent.clone())
                    .or_default()
                    .insert(name.clone());
            }
            Ok((id, parent, name, content))
        })
        .collect::<DomainResult<Vec<_>>>()?;
    let mut paths = HashMap::new();
    let mut entries = Vec::with_capacity(rows.len());
    let mut path_bytes = 0;
    let mut push = |path: String, content| {
        path_bytes += path.len();
        if path.len() > MAX_PATH || path_bytes > MAX_PATH_BYTES || entries.len() == MAX_ENTRIES {
            return Err(too_large());
        }
        entries.push((path, content));
        Ok(())
    };
    for (id, parent, name, content) in rows {
        let parent = parent.filter(|_| id != root.id);
        let prefix: &str = if let Some(parent) = &parent {
            paths
                .get(parent)
                .map(String::as_str)
                .ok_or_else(ApiError::unavailable)?
        } else {
            ""
        };

        // Notes are files that can themselves have children. Archive the note as an export,
        // and put its children under a directory with the note's original basename.
        let directory = matches!(content, Content::Directory);
        let children_path =
            (directory || parents.contains(&id)).then(|| format!("{prefix}{name}/"));
        if let Some(path) = &children_path {
            push(path.clone(), Content::Directory)?;
        }
        if !directory {
            let mut basename = name.clone();
            if matches!(content, Content::Note { .. })
                && let Some(parent) = parent
            {
                let siblings = names.entry(parent).or_default();
                basename = format!("{name}.hyori-note.json");
                for number in 2.. {
                    if siblings.insert(basename.clone()) {
                        break;
                    }
                    basename = format!("{name} ({number}).hyori-note.json");
                }
            }
            push(format!("{prefix}{basename}"), content)?;
        }
        if let Some(path) = children_path {
            paths.insert(id, path);
        }
    }
    Ok((format!("{}.zip", segment(&root.name)), entries))
}

pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    validate_origin(request.headers(), &state.config.origin)?;
    let permit = state
        .transfers
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    let archive = state
        .archives
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    let context = state.request_context(request.headers());
    let (name, entries) = FilesService::new(&state, context.clone())
        .run(move |tx, actor| {
            let id = id.clone();
            Box::pin(async move { manifest(tx, authorize_folder(tx, &actor, &id).await?).await })
        })
        .await?;
    if state.storage.is_none()
        && entries
            .iter()
            .any(|(_, content)| matches!(content, Content::Object { .. }))
    {
        return Err(ApiError::unavailable());
    }

    let (sender, receiver) = mpsc::channel(1);
    let runtime = Handle::current();
    // The ZIP library writes synchronously. A bounded bridge backpressures it without blocking
    // the async server; only one object or bounded Note export is open at a time.
    let worker = tokio::task::spawn_blocking(move || {
        let _archive = archive;
        write_zip(&sender, &runtime, &state, context, entries)
    });
    let source: StorageStream = Box::pin(stream::unfold(Some((receiver, worker)), |state| async {
        let (mut receiver, worker) = state?;
        if let Some(bytes) = receiver.recv().await {
            Some((Ok(bytes), Some((receiver, worker))))
        } else if matches!(worker.await, Ok(Ok(()))) {
            None
        } else {
            Some((Err(StorageError::Body("folder ZIP interrupted")), None))
        }
    }));
    Response::builder()
        .header("content-type", ZIP_MIME)
        .header(
            "content-disposition",
            format!(
                "attachment; filename=\"folder.zip\"; filename*=UTF-8''{}",
                encoded_filename(&name)
            ),
        )
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox; default-src 'none'")
        .body(stream_download(source, permit))
        .map_err(|_| ApiError::unavailable())
}

struct Bridge<'a> {
    sender: &'a mpsc::Sender<Bytes>,
    failed: &'a Cell<bool>,
}
impl Write for Bridge<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if !self.failed.get() {
            for chunk in data.chunks(CHUNK) {
                self.sender
                    .blocking_send(Bytes::copy_from_slice(chunk))
                    .map_err(|_| io::ErrorKind::BrokenPipe)?;
            }
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn write_zip(
    sender: &mpsc::Sender<Bytes>,
    runtime: &Handle,
    state: &Arc<AppState>,
    context: RequestContext,
    entries: Vec<(String, Content)>,
) -> zip::result::ZipResult<()> {
    let failed = Cell::new(false);
    let mut zip = ZipWriter::new_stream(BufWriter::with_capacity(
        CHUNK,
        Bridge {
            sender,
            failed: &failed,
        },
    ));
    let notes = NotesService::new(state, context);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let result = (|| -> zip::result::ZipResult<()> {
        for (path, content) in entries {
            match content {
                Content::Directory => zip.add_directory(path, options)?,
                Content::Note { id, fence } => {
                    let (_, bytes) = runtime.block_on(async {
                        tokio::select! {
                            _ = sender.closed() => Err(io::ErrorKind::BrokenPipe.into()),
                            note = notes.download(id, fence) => note.map_err(io::Error::other),
                        }
                    })?;
                    zip.start_file(path, options)?;
                    zip.write_all(&bytes)?;
                }
                Content::Object { key, size } => {
                    let storage = state
                        .storage
                        .as_ref()
                        .ok_or(io::Error::from(io::ErrorKind::NotConnected))?;
                    let mut read = runtime.block_on(async {
                        tokio::select! {
                            _ = sender.closed() => Err(io::ErrorKind::BrokenPipe.into()),
                            read = storage.read(&key, None) => read.map_err(io::Error::other),
                        }
                    })?;
                    if read.size != size {
                        return Err(io::Error::from(io::ErrorKind::InvalidData).into());
                    }
                    zip.start_file(path, options.large_file(size >= u64::from(u32::MAX)))?;
                    while let Some(chunk) = runtime.block_on(async { tokio::select! {
                        _ = sender.closed() => Some(Err(StorageError::Body("archive reader disconnected"))),
                        chunk = read.body.next() => chunk,
                    } }) {
                        zip.write_all(&chunk.map_err(io::Error::other)?)?;
                    }
                }
            }
        }
        Ok(())
    })();
    // ZipWriter finalizes on drop. On failure, suppress its footer and report a body error
    // instead of yielding a valid-looking archive that is missing entries.
    failed.set(result.is_err());
    result?;
    Ok(zip.finish()?.flush()?)
}

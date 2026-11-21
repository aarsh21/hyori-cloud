use crate::{
    features::auth::api::{Bytes, Empty, Id, Name, Timestamp},
    wire::{Manifest, Nullable},
};
crate::wire_enum!(ShareRole { Viewer => "viewer", Contributor => "contributor", Editor => "editor" });
crate::wire_enum!(FileKind { File => "file", Folder => "folder" });
crate::wire_enum!(FilesView { Files => "files", Shared => "shared", Trash => "trash" });
crate::wire_enum!(FileSort { NameAsc => "nameAsc", NameDesc => "nameDesc", SizeAsc => "sizeAsc", SizeDesc => "sizeDesc", ModifiedAsc => "modifiedAsc", ModifiedDesc => "modifiedDesc" });
crate::wire_struct!(Access { role: Nullable<ShareRole>, is_owner: bool, can_download: bool, can_upload: bool, can_edit: bool, can_rename: bool, can_delete: bool, can_share: bool });
crate::wire_struct!(FileEntry { id: Id, name: Name, kind: FileKind, parent_id: Nullable<Id>, owner_id: Id, size: Bytes, mime_type: String, created_at: String, updated_at: String, trashed_at: Nullable<String>, access: Access });
crate::wire_struct!(FileListEntry {
    #[serde(flatten)]
    file: FileEntry,
    /// Active direct children, independent of the list's filter or page. Active list folders only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64", range(max = 9007199254740991_u64))]
    child_count: Option<u64>,
    /// Trash list only. Names from the library root to the original parent; empty at the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<Name>", length(max = 63))]
    original_parent_path: Option<Vec<Name>>
});
crate::wire_struct!(ItemInput { id: Id });
crate::wire_struct!(ListFiles {
    #[serde(default, skip_serializing_if = "Option::is_none")] parent_id: Option<Nullable<Id>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "FilesView")] view: Option<FilesView>,
    #[serde(default, skip_serializing_if = "Option::is_none")] sort: Option<FileSort>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "String", length(max = 255))] search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "String", length(max = 128))] r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Timestamp")] after: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Timestamp")] before: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Bytes")] min_size: Option<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Bytes")] max_size: Option<Bytes>,
    #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Nullable<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "u32", range(min = 1, max = 100))] limit: Option<u32>
});
crate::wire_struct!(Breadcrumb { id: Id, name: Name });
crate::wire_struct!(FileThumbnail { url: Nullable<String>, pending: bool });
crate::wire_struct!(FileShareSummary {
    people_count: u32,
    has_link: bool
});
crate::wire_struct!(FileList {
    items: Vec<FileListEntry>, breadcrumbs: Vec<Breadcrumb>, next_cursor: Nullable<String>, folder: Nullable<FileListEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "std::collections::BTreeMap<String, FileThumbnail>")]
    thumbnails: Option<std::collections::BTreeMap<String, FileThumbnail>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "std::collections::BTreeMap<String, FileShareSummary>")]
    sharing: Option<std::collections::BTreeMap<String, FileShareSummary>>
});
// The service trims/NFC-normalizes before validating the final Name; JSON body size bounds input.
crate::wire_struct!(CreateFolder { parent_id: Nullable<Id>, #[schemars(with = "String")] name: Name });
crate::wire_struct!(RenameFile {
    id: Id,
    #[schemars(with = "String")]
    name: Name,
    #[serde(default, skip_serializing_if = "Option::is_none")] expected_name: Option<Name>
});
crate::wire_struct!(MoveFile { id: Id, parent_id: Nullable<Id> });
crate::wire_struct!(FileVersion {
    id: Id,
    file_id: Id,
    size: Bytes,
    created_at: String
});
crate::wire_struct!(Versions { items: Vec<FileVersion>, next_cursor: Nullable<String> });
crate::wire_struct!(ListVersions { id: Id, #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Nullable<String>> });
crate::wire_struct!(RestoreVersion {
    id: Id,
    version_id: Id
});
crate::wire_struct!(DeleteVersion {
    id: Id,
    version_id: Id
});
// `items` counts removed items (a folder includes its contents) or versions. `freedBytes` is the
// quota released now; objects still referenced elsewhere stay stored and charged.
crate::wire_struct!(PermanentDeletion {
    items: Bytes,
    freed_bytes: Bytes
});
// `items` counts Trash's top-level entries; `freedBytes` is what emptying it would release.
crate::wire_struct!(TrashSummary {
    items: Bytes,
    freed_bytes: Bytes
});
crate::wire_struct!(DownloadInput { id: Id, #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Id")] version_id: Option<Id> });
crate::wire_struct!(Download {
    url: String,
    name: Name,
    size: Bytes,
    mime_type: String
});
crate::wire_struct!(FolderDownload {
    url: String,
    name: String,
    mime_type: String
});
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::files::service::FilesService, rpc::RpcResult};
    registry.bind::<ItemInput, FileEntry, _, _>(
        "files.get",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).get(input).await?,
            ))
        },
    )?;
    registry.bind::<DownloadInput, Download, _, _>(
        "files.preview",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).preview(input).await?,
            ))
        },
    )?;
    registry.bind::<ListFiles, FileList, _, _>(
        "files.list",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).list(input).await?,
            ))
        },
    )?;
    registry.bind::<CreateFolder, FileEntry, _, _>(
        "files.createFolder",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context)
                    .create_folder(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<RenameFile, FileEntry, _, _>(
        "files.rename",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).rename(input).await?,
            ))
        },
    )?;
    registry.bind::<MoveFile, FileEntry, _, _>(
        "files.move",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).move_item(input).await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, FileEntry, _, _>(
        "files.trash",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).trash(input).await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, FileEntry, _, _>(
        "files.restore",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).restore(input).await?,
            ))
        },
    )?;
    registry.bind::<ListVersions, Versions, _, _>(
        "files.versions",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).versions(input).await?,
            ))
        },
    )?;
    registry.bind::<RestoreVersion, FileEntry, _, _>(
        "files.restoreVersion",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context)
                    .restore_version(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, PermanentDeletion, _, _>(
        "files.deletePermanently",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context)
                    .delete_permanently(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<Empty, PermanentDeletion, _, _>(
        "files.emptyTrash",
        |state, context, _| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).empty_trash().await?,
            ))
        },
    )?;
    registry.bind::<Empty, TrashSummary, _, _>(
        "files.trashSummary",
        |state, context, _| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).trash_summary().await?,
            ))
        },
    )?;
    registry.bind::<DeleteVersion, PermanentDeletion, _, _>(
        "files.deleteVersion",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context)
                    .delete_version(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<DownloadInput, Download, _, _>(
        "files.download",
        |state, context, input| async move {
            Ok(RpcResult::value(
                FilesService::new(&state, context).download(input).await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, FolderDownload, _, _>(
        "files.downloadFolder",
        |state, context, input| async move {
            Ok(RpcResult::value(
                super::archive::describe(&state, context, input.id.0).await?,
            ))
        },
    )?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; ShareRole, Access, FileEntry, ItemInput, ListFiles, FileList, FileShareSummary, CreateFolder, RenameFile, MoveFile, FileVersion, Versions, ListVersions, RestoreVersion, DeleteVersion, PermanentDeletion, TrashSummary, DownloadInput, Download, FolderDownload);
    crate::operation!(m, "files.list", ListFiles, FileList, "query", [], false);
    crate::operation!(m, "files.get", ItemInput, FileEntry, "query", [], false);
    crate::operation!(
        m,
        "files.preview",
        DownloadInput,
        Download,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "files.createFolder",
        CreateFolder,
        FileEntry,
        "mutation",
        ["files", "photos"],
        false
    );
    crate::operation!(
        m,
        "files.rename",
        RenameFile,
        FileEntry,
        "mutation",
        ["files", "photos", "notes", "shares"],
        false
    );
    crate::operation!(
        m,
        "files.move",
        MoveFile,
        FileEntry,
        "mutation",
        ["files", "photos", "shares", "media", "notes"],
        false
    );
    crate::operation!(
        m,
        "files.trash",
        ItemInput,
        FileEntry,
        "mutation",
        ["files", "photos", "shares", "media", "notes"],
        false
    );
    crate::operation!(
        m,
        "files.restore",
        ItemInput,
        FileEntry,
        "mutation",
        ["files", "photos", "media", "notes", "shares"],
        false
    );
    crate::operation!(
        m,
        "files.versions",
        ListVersions,
        Versions,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "files.restoreVersion",
        RestoreVersion,
        FileEntry,
        "mutation",
        ["files", "photos", "auth", "media", "notes"],
        false
    );
    crate::operation!(
        m,
        "files.deletePermanently",
        ItemInput,
        PermanentDeletion,
        "mutation",
        ["files", "photos", "shares", "media", "auth", "notes"],
        false
    );
    crate::operation!(
        m,
        "files.emptyTrash",
        Empty,
        PermanentDeletion,
        "mutation",
        ["files", "photos", "shares", "media", "auth", "notes"],
        false
    );
    crate::operation!(
        m,
        "files.trashSummary",
        Empty,
        TrashSummary,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "files.deleteVersion",
        DeleteVersion,
        PermanentDeletion,
        "mutation",
        ["files", "auth"],
        false
    );
    crate::operation!(
        m,
        "files.download",
        DownloadInput,
        Download,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "files.downloadFolder",
        ItemInput,
        FolderDownload,
        "query",
        [],
        false
    );
    Ok(())
}

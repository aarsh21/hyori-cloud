use crate::{
    features::{
        auth::api::{Done, Id, Name},
        files::api::{FileEntry, ItemInput},
    },
    wire::{Manifest, Nullable},
};

crate::wire_struct!(Note {
    file: FileEntry,
    generation: Id,
    metadata_revision: String,
    favorite: bool
});
crate::wire_struct!(NoteListInput {
    #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(length(max = 255))] search: Option<String>,
    #[serde(default)] trash: bool,
    #[serde(default)] favorites: bool
});
crate::wire_struct!(NoteList { items: Vec<Note>, next_cursor: Nullable<Id> });
crate::wire_struct!(CreateNote {
    parent_id: Nullable<Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")] name: Option<Name>
});
crate::wire_struct!(RenameNote {
    id: Id,
    name: Name,
    expected_name: Name
});
crate::wire_struct!(FavoriteNote {
    id: Id,
    favorite: bool
});
crate::wire_struct!(NoteCheckpoint {
    id: Id,
    name: Name,
    created_at: String
});
crate::wire_struct!(NoteHistoryInput {
    id: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Id>
});
crate::wire_struct!(NoteHistory { items: Vec<NoteCheckpoint>, next_cursor: Nullable<Id> });
crate::wire_struct!(RestoreNoteCheckpoint {
    id: Id,
    checkpoint_id: Id
});

pub fn bind(r: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use super::service::NotesService;
    use crate::rpc::RpcResult;
    r.bind::<NoteListInput, NoteList, _, _>("notes.list", |s, c, i| async move {
        NotesService::new(&s, c).list(i).await.map(RpcResult::value)
    })?;
    r.bind::<ItemInput, Note, _, _>("notes.get", |s, c, i| async move {
        NotesService::new(&s, c).get(i).await.map(RpcResult::value)
    })?;
    r.bind::<CreateNote, Note, _, _>("notes.create", |s, c, i| async move {
        NotesService::new(&s, c)
            .create(i)
            .await
            .map(RpcResult::value)
    })?;
    r.bind::<RenameNote, Note, _, _>("notes.rename", |s, c, i| async move {
        NotesService::new(&s, c)
            .rename(i)
            .await
            .map(RpcResult::value)
    })?;
    r.bind::<FavoriteNote, Done, _, _>("notes.favorite", |s, c, i| async move {
        NotesService::new(&s, c)
            .favorite(i)
            .await
            .map(RpcResult::value)
    })?;
    r.bind::<NoteHistoryInput, NoteHistory, _, _>("notes.history", |s, c, i| async move {
        NotesService::new(&s, c)
            .history(i)
            .await
            .map(RpcResult::value)
    })?;
    r.bind::<ItemInput, NoteCheckpoint, _, _>("notes.checkpoint", |s, c, i| async move {
        NotesService::new(&s, c)
            .checkpoint(i)
            .await
            .map(RpcResult::value)
    })?;
    r.bind::<RestoreNoteCheckpoint, Note, _, _>("notes.restoreCheckpoint", |s, c, i| async move {
        NotesService::new(&s, c)
            .restore_checkpoint(i)
            .await
            .map(RpcResult::value)
    })?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::operation!(m, "notes.list", NoteListInput, NoteList, "query", [], false);
    crate::operation!(m, "notes.get", ItemInput, Note, "query", [], false);
    crate::operation!(
        m,
        "notes.create",
        CreateNote,
        Note,
        "mutation",
        ["notes", "files"],
        false
    );
    crate::operation!(
        m,
        "notes.rename",
        RenameNote,
        Note,
        "mutation",
        ["notes", "files", "shares"],
        false
    );
    crate::operation!(
        m,
        "notes.favorite",
        FavoriteNote,
        Done,
        "mutation",
        ["notes"],
        false
    );
    crate::operation!(
        m,
        "notes.history",
        NoteHistoryInput,
        NoteHistory,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "notes.checkpoint",
        ItemInput,
        NoteCheckpoint,
        "mutation",
        ["notes"],
        false
    );
    crate::operation!(
        m,
        "notes.restoreCheckpoint",
        RestoreNoteCheckpoint,
        Note,
        "mutation",
        ["notes", "files"],
        false
    );
    Ok(())
}

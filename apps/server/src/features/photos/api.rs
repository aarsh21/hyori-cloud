use crate::{
    features::{
        auth::api::{Done, Empty, Id, Name},
        files::api::{Breadcrumb, FileEntry, ItemInput},
    },
    wire::{Manifest, Nullable},
};
crate::wire_struct!(PhotoSources { all_my_files: bool, #[schemars(length(max = 100))] folder_ids: Vec<Id> });
crate::wire_struct!(TimelineInput { #[serde(default, skip_serializing_if = "Option::is_none")] cursor: Option<Nullable<String>>, #[serde(default, skip_serializing_if = "Option::is_none")] #[schemars(with = "Id")] album_id: Option<Id> });
crate::wire_struct!(TimelineItem {
    #[serde(flatten)]
    file: FileEntry,
    preview_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::features::media::api::MediaDerivative")]
    derivative: Option<crate::features::media::api::MediaDerivative>
});
crate::wire_struct!(Timeline { items: Vec<TimelineItem>, breadcrumbs: Vec<Breadcrumb>, next_cursor: Nullable<String>, folder: Nullable<FileEntry> });
crate::wire_struct!(LibraryInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<Nullable<String>>
});
crate::wire_enum!(PhotoDateSource { Capture => "capture", Upload => "upload" });
crate::wire_struct!(LibraryItem {
    #[serde(flatten)]
    item: TimelineItem,
    timeline_date: String,
    date_source: PhotoDateSource
});
crate::wire_struct!(PhotoLibrary { items: Vec<LibraryItem>, next_cursor: Nullable<String> });
crate::wire_struct!(PhotoCapture { local_date_time: String, offset_minutes: Nullable<i32> });
crate::wire_struct!(PhotoLocation {
    latitude: f64,
    longitude: f64
});
crate::wire_struct!(PhotoDetails { capture: Nullable<PhotoCapture>, location: Nullable<PhotoLocation> });
crate::wire_struct!(Album {
    id: Id,
    name: Name,
    created_at: String,
    count: f64
});
crate::wire_struct!(Albums { items: Vec<Album> });
crate::wire_struct!(CreateAlbum { name: Name });
crate::wire_struct!(AddToAlbum { album_id: Id, #[schemars(length(max = 100))] file_ids: Vec<Id> });
pub fn bind(registry: &mut crate::rpc::RpcRegistry) -> crate::wire::ContractResult<()> {
    use crate::{features::photos::service::PhotosService, rpc::RpcResult};
    registry.bind::<Empty, PhotoSources, _, _>(
        "photos.sources",
        |state, context, _| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context).sources().await?,
            ))
        },
    )?;
    registry.bind::<PhotoSources, PhotoSources, _, _>(
        "photos.setSources",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context)
                    .set_sources(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<TimelineInput, Timeline, _, _>(
        "photos.timeline",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context).timeline(input).await?,
            ))
        },
    )?;
    registry.bind::<LibraryInput, PhotoLibrary, _, _>(
        "photos.library",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context).library(input).await?,
            ))
        },
    )?;
    registry.bind::<ItemInput, PhotoDetails, _, _>(
        "photos.details",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context)
                    .details(input.id)
                    .await?,
            ))
        },
    )?;
    registry.bind::<Empty, Albums, _, _>("photos.albums", |state, context, _| async move {
        Ok(RpcResult::value(
            PhotosService::new(&state, context).albums().await?,
        ))
    })?;
    registry.bind::<CreateAlbum, Album, _, _>(
        "photos.createAlbum",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context)
                    .create_album(input)
                    .await?,
            ))
        },
    )?;
    registry.bind::<AddToAlbum, Done, _, _>(
        "photos.addToAlbum",
        |state, context, input| async move {
            Ok(RpcResult::value(
                PhotosService::new(&state, context)
                    .add_to_album(input)
                    .await?,
            ))
        },
    )?;
    Ok(())
}
pub fn register(m: &mut Manifest) -> crate::wire::ContractResult<()> {
    crate::schemas!(m; PhotoSources, TimelineInput, Timeline, LibraryInput, PhotoLibrary, PhotoDetails, Album, Albums, CreateAlbum, AddToAlbum);
    crate::operation!(m, "photos.sources", Empty, PhotoSources, "query", [], false);
    crate::operation!(
        m,
        "photos.setSources",
        PhotoSources,
        PhotoSources,
        "mutation",
        ["photos"],
        false
    );
    crate::operation!(
        m,
        "photos.timeline",
        TimelineInput,
        Timeline,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "photos.library",
        LibraryInput,
        PhotoLibrary,
        "query",
        [],
        false
    );
    crate::operation!(
        m,
        "photos.details",
        ItemInput,
        PhotoDetails,
        "query",
        [],
        false
    );
    crate::operation!(m, "photos.albums", Empty, Albums, "query", [], false);
    crate::operation!(
        m,
        "photos.createAlbum",
        CreateAlbum,
        Album,
        "mutation",
        ["photos"],
        false
    );
    crate::operation!(
        m,
        "photos.addToAlbum",
        AddToAlbum,
        Done,
        "mutation",
        ["photos"],
        false
    );
    Ok(())
}

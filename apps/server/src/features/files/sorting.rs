use super::{api::FileSort, db::Item};
use crate::error::ApiError;
use chrono::{DateTime, Utc};
use sea_orm::Value;
use serde::{Deserialize, Serialize};

const FOLDER_NAME: &str = "CASE WHEN i.kind='folder' THEN lower(i.name) ELSE '' END";

// A value cursor survives deleting the boundary item; it never grants access to that item.
#[derive(Serialize, Deserialize)]
struct SortCursor {
    sort: FileSort,
    file: bool,
    id: String,
    name: String,
    size: i64,
    modified: DateTime<Utc>,
}

pub(super) fn encode(sort: &FileSort, item: &Item) -> Result<String, ApiError> {
    serde_json::to_string(&SortCursor {
        sort: sort.clone(),
        file: item.kind == super::api::FileKind::File,
        id: item.id.clone(),
        name: item.name.clone(),
        size: item.size,
        modified: item.updated_at,
    })
    .map_err(|_| ApiError::unavailable())
}

fn keys(sort: &FileSort) -> (&'static str, &'static str, &'static str) {
    let (column, direction) = match sort {
        FileSort::NameAsc => ("lower(i.name)", "ASC"),
        FileSort::NameDesc => ("lower(i.name)", "DESC"),
        FileSort::SizeAsc => ("CASE WHEN i.kind='folder' THEN 0 ELSE i.size END", "ASC"),
        FileSort::SizeDesc => ("CASE WHEN i.kind='folder' THEN 0 ELSE i.size END", "DESC"),
        FileSort::ModifiedAsc => ("i.updated_at", "ASC"),
        FileSort::ModifiedDesc => ("i.updated_at", "DESC"),
    };
    // Invert the group for DESC too: all tuple fields then share one seek direction,
    // while folders still lead. A mixed-direction OR predicate cannot seek deep pages.
    let group = if direction == "ASC" {
        "(i.kind='file')"
    } else {
        "(i.kind='folder')"
    };
    (group, column, direction)
}

pub(super) fn ordering(sort: &FileSort) -> String {
    let (group, column, direction) = keys(sort);
    let folder_name = if matches!(sort, FileSort::SizeAsc | FileSort::SizeDesc) {
        format!(",{FOLDER_NAME} {direction}")
    } else {
        String::new()
    };
    format!("{group} {direction},{column} {direction}{folder_name},i.id {direction}")
}

pub(super) fn predicate(
    sort: &FileSort,
    cursor: Option<&str>,
    bind: &mut impl FnMut(Value) -> String,
) -> Result<String, ApiError> {
    let Some(cursor) = cursor else {
        return Ok("true".into());
    };
    if cursor.len() > 4096 {
        return Err(ApiError::invalid());
    }
    let cursor: SortCursor = serde_json::from_str(cursor).map_err(|_| ApiError::invalid())?;
    if &cursor.sort != sort {
        return Err(ApiError::new(
            crate::error::ErrorCode::InvalidInput,
            "Cursor sort does not match the requested sort; start a new listing",
        ));
    }
    let (group, column, direction) = keys(sort);
    let file = bind(
        if direction == "ASC" {
            cursor.file
        } else {
            !cursor.file
        }
        .into(),
    );
    let value = bind(match sort {
        FileSort::NameAsc | FileSort::NameDesc => cursor.name.clone().into(),
        FileSort::SizeAsc | FileSort::SizeDesc => {
            (if cursor.file { cursor.size } else { 0 }).into()
        }
        FileSort::ModifiedAsc | FileSort::ModifiedDesc => cursor.modified.into(),
    });
    let value = if matches!(sort, FileSort::NameAsc | FileSort::NameDesc) {
        format!("lower({value})")
    } else {
        value
    };
    // Folders have no meaningful size. Within either size order their names follow that
    // direction; file size ties still use ID, not name. Keep this in the same tuple seek.
    let (column, value) = if matches!(sort, FileSort::SizeAsc | FileSort::SizeDesc) {
        let name = bind(
            if cursor.file {
                String::new()
            } else {
                cursor.name
            }
            .into(),
        );
        (
            format!("{column},{FOLDER_NAME}"),
            format!("{value},lower({name})"),
        )
    } else {
        (column.into(), value)
    };
    let id = bind(cursor.id.into());
    let comparison = if direction == "ASC" { ">" } else { "<" };
    Ok(format!(
        "({group},{column},i.id){comparison}({file},{value},{id})"
    ))
}

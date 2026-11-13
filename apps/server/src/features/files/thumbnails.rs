use super::{api::FileThumbnail, db::Item};
use crate::{
    db::DomainResult,
    features::media::{api::MediaDerivative, service},
    wire::Nullable,
};
use sea_orm::DatabaseTransaction;
use std::collections::BTreeMap;

/// Only the already-authorized, selected page reaches this projection. Its URLs reauthorize
/// through the same Files policy on every GET, including public-link capability checks.
pub(crate) async fn describe(
    tx: &DatabaseTransaction,
    page: &[Item],
    enabled: bool,
    trash: bool,
) -> DomainResult<Option<BTreeMap<String, FileThumbnail>>> {
    let media: Vec<_> = page
        .iter()
        .filter(|item| !trash && service::supported(item))
        .cloned()
        .collect();
    if media.is_empty() {
        return Ok(None);
    }
    let derivatives = service::describe_page(tx, &media, enabled).await?;
    Ok(Some(
        media
            .into_iter()
            .zip(derivatives)
            .map(|(item, derivative)| {
                let (url, pending) = match derivative {
                    MediaDerivative::Ready { url, .. } => (Some(url), false),
                    MediaDerivative::Queued { .. } | MediaDerivative::Processing { .. } => {
                        (None, true)
                    }
                    _ => (None, false),
                };
                (
                    item.id,
                    FileThumbnail {
                        url: Nullable(url),
                        pending,
                    },
                )
            })
            .collect(),
    ))
}

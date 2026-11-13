use crate::{AppState, db::sql, error::ApiError};
use hyori_media_worker::RECIPE;
use sea_orm::ConnectionTrait;

/// A transport failure, busy worker or lost lease says nothing about the input's decodability.
/// Release its verdict attempt and back off 20, 40, ... 640 seconds (then stay at 640), durably.
/// Both explicit failures and lease expiry use this policy, behind new-upload priority.
/// A reader's Retry (any attempt past the third) uses it too, at ordinary priority.
pub(crate) const TRANSIENT_UPDATE: &str = "state='queued',attempts=greatest(0,attempts-1),
    upgrade_failures=least(6,upgrade_failures+1),
    due_at=now()+(10*(1<<least(6,upgrade_failures+1)))*interval '1 second',
    lease_token=NULL,lease_until=NULL";

/// Share discovery's bounded item-ID window. Ready/processing work is never rewritten.
/// Same-decoder transient backoff is preserved; repair only v1's stranded terminal transients.
/// A backoff a reader's Retry earned against another decoder, or none, is dropped like a failure:
/// pressing Retry while the worker is away must not delay recovery once it returns.
/// The version is the connected worker's content fingerprint, not the server build or start time.
pub(crate) async fn requeue_page(
    state: &AppState,
    after: &str,
    last: &str,
    revision: &str,
) -> Result<(), ApiError> {
    state.db.execute_raw(sql("WITH candidates AS (
        SELECT j.id FROM hyori_items i JOIN hyori_media_jobs j ON j.source_key=i.object_key AND j.recipe=$3
        WHERE i.id>$1 AND i.id<=$2 AND i.trashed_at IS NULL
          AND (j.state IN ('failed','unsupported') OR (j.state='queued' AND (j.upgrade_retry OR j.upgrade_failures>0)))
          AND (j.decoder_revision IS DISTINCT FROM $4
            OR (j.upgrade_retry AND j.state='failed' AND j.failure IN ('unavailable','timeout','busy')
              AND (j.failure<>'timeout' OR j.failure_detail->>'reason' IS DISTINCT FROM 'deadline')))
        FOR UPDATE OF j SKIP LOCKED
    ) UPDATE hyori_media_jobs j SET state='queued',attempts=0,upgrade_failures=0,failure=NULL,failure_detail=NULL,
        decoder_revision=$4,upgrade_retry=true,due_at=now(),deferred=false,lease_token=NULL,lease_until=NULL
        FROM candidates c WHERE j.id=c.id",
        vec![after.into(),last.into(),RECIPE.into(),revision.into()])).await?;
    Ok(())
}

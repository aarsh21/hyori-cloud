-- Clean terminal inventory is revisited with exponential backoff instead of hourly forever.
-- clean_checks counts consecutive clean observations; any new obligation resets it to zero.
ALTER TABLE hyori_uploads ADD COLUMN clean_checks integer NOT NULL DEFAULT 0 CHECK (clean_checks >= 0);
ALTER TABLE hyori_media_artifacts ADD COLUMN clean_checks integer NOT NULL DEFAULT 0 CHECK (clean_checks >= 0);

-- Urgent work (never checked clean, or superseded and not yet reclaimed) is claimed before
-- revisits. The two predicates partition every row, so each claim is one index range scan.
DROP INDEX hyori_uploads_cleanup;
CREATE INDEX hyori_uploads_cleanup_urgent ON hyori_uploads(cleanup_due,id)
    WHERE clean_checks = 0 OR (editor_superseded AND editor_reclaimed_at IS NULL);
CREATE INDEX hyori_uploads_cleanup_revisit ON hyori_uploads(cleanup_due,id)
    WHERE clean_checks > 0 AND NOT (editor_superseded AND editor_reclaimed_at IS NULL);
DROP INDEX hyori_media_artifacts_due;
CREATE INDEX hyori_media_artifacts_cleanup_urgent ON hyori_media_artifacts(cleanup_due,id) WHERE clean_checks = 0;
CREATE INDEX hyori_media_artifacts_cleanup_revisit ON hyori_media_artifacts(cleanup_due,id) WHERE clean_checks > 0;

-- Who holds a reservation in someone's space: the account ID, or the sorted public share IDs
-- an anonymous contributor used. Per-initiator caps count only held reservations.
ALTER TABLE hyori_uploads ADD COLUMN initiator text;
UPDATE hyori_uploads SET initiator = coalesce(uploader_id, 'shares:legacy') WHERE reservation_held;
CREATE INDEX hyori_uploads_initiator ON hyori_uploads(owner_id,initiator) WHERE reservation_held;

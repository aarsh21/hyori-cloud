-- Fast metadata-only additions; preserve recipe-1 ready artifacts and every existing original.
SET LOCAL lock_timeout='2s';
ALTER TABLE hyori_media_jobs
    ADD COLUMN decoder_revision text,
    ADD COLUMN upgrade_retry boolean NOT NULL DEFAULT false,
    ADD COLUMN failure_detail jsonb;
CREATE INDEX hyori_media_jobs_priority_due ON hyori_media_jobs(upgrade_retry,due_at,id)
    WHERE state IN ('queued','processing');
SET LOCAL lock_timeout='5s';

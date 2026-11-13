SET LOCAL lock_timeout='2s';
-- Infrastructure failures do not spend a decoder verdict. Keep their backoff across restarts.
ALTER TABLE hyori_media_jobs ADD COLUMN upgrade_failures integer NOT NULL DEFAULT 0
    CHECK (upgrade_failures BETWEEN 0 AND 6);
SET LOCAL lock_timeout='5s';

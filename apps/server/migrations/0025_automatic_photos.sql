SET LOCAL lock_timeout='2s';
ALTER TABLE hyori_items
    ADD COLUMN photo_taken_at timestamp,
    ADD COLUMN photo_offset_minutes integer,
    ADD COLUMN photo_latitude double precision,
    ADD COLUMN photo_longitude double precision,
    -- NULL means inspected (including a file with no metadata). A future value is a lease.
    ADD COLUMN photo_probe_due timestamptz DEFAULT '-infinity';

CREATE FUNCTION hyori_invalidate_photo_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.photo_taken_at := NULL;
    NEW.photo_offset_minutes := NULL;
    NEW.photo_latitude := NULL;
    NEW.photo_longitude := NULL;
    NEW.photo_probe_due := '-infinity';
    RETURN NEW;
END;
$$;
CREATE TRIGGER hyori_item_photo_source_changed BEFORE UPDATE OF object_key,mime_type ON hyori_items
    FOR EACH ROW WHEN (OLD.object_key IS DISTINCT FROM NEW.object_key OR OLD.mime_type IS DISTINCT FROM NEW.mime_type)
    EXECUTE FUNCTION hyori_invalidate_photo_metadata();

-- The library's query predicate must match this index, including the literal MIME allowlist.
-- No originals or item rows are rewritten. Index builds are bounded but can hold a write lock.
SET LOCAL statement_timeout='120s';
CREATE INDEX hyori_items_photo_library ON hyori_items
    (owner_id, (coalesce(photo_taken_at, created_at AT TIME ZONE 'UTC')) DESC, id DESC)
    WHERE kind='file' AND trashed_at IS NULL AND object_key IS NOT NULL AND mime_type IN
    ('image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime');
CREATE INDEX hyori_items_photo_probe ON hyori_items(photo_probe_due,id)
    WHERE kind='file' AND trashed_at IS NULL AND object_key IS NOT NULL AND photo_probe_due IS NOT NULL
    AND size BETWEEN 1 AND 67108864 AND mime_type IN
    ('image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm','video/quicktime');
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='5s';

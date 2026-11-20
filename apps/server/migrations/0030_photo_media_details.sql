SET LOCAL lock_timeout='2s';
ALTER TABLE hyori_items
    ADD COLUMN photo_camera_make text,
    ADD COLUMN photo_camera_model text,
    ADD COLUMN photo_width integer,
    ADD COLUMN photo_height integer,
    ADD COLUMN photo_probe_version integer NOT NULL DEFAULT 0;

-- Preserve the tile budget for existing recipe 1 artifacts. Display recipe 2 has its own budget.
ALTER TABLE hyori_media_artifacts
    ADD COLUMN recipe integer NOT NULL DEFAULT 1,
    DROP CONSTRAINT hyori_media_artifacts_geometry,
    ADD CONSTRAINT hyori_media_artifacts_geometry CHECK (
        state <> 'ready'
        OR (recipe = 1 AND size BETWEEN 1 AND 262144 AND width BETWEEN 1 AND 384 AND height BETWEEN 1 AND 384)
        OR (recipe = 2 AND size BETWEEN 1 AND 2097152 AND width BETWEEN 1 AND 2560 AND height BETWEEN 1 AND 2560)
    ) NOT VALID;

CREATE OR REPLACE FUNCTION hyori_invalidate_photo_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.photo_taken_at := NULL;
    NEW.photo_offset_minutes := NULL;
    NEW.photo_latitude := NULL;
    NEW.photo_longitude := NULL;
    NEW.photo_camera_make := NULL;
    NEW.photo_camera_model := NULL;
    NEW.photo_width := NULL;
    NEW.photo_height := NULL;
    NEW.photo_probe_due := '-infinity';
    NEW.photo_probe_version := 0;
    RETURN NEW;
END;
$$;

-- Replace the two partial indexes without rewriting existing items or derivative artifacts.
SET LOCAL statement_timeout='120s';
DROP INDEX hyori_items_photo_library;
DROP INDEX hyori_items_photo_probe;
CREATE INDEX hyori_items_photo_library ON hyori_items
    (owner_id, (coalesce(photo_taken_at, created_at AT TIME ZONE 'UTC')) DESC, id DESC)
    WHERE kind='file' AND trashed_at IS NULL AND object_key IS NOT NULL AND mime_type IN
    ('image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif','video/mp4','video/webm','video/quicktime');
CREATE INDEX hyori_items_photo_probe ON hyori_items ((coalesce(photo_probe_due,'-infinity'::timestamptz)),id)
    WHERE kind='file' AND trashed_at IS NULL AND object_key IS NOT NULL
    AND (photo_probe_due IS NOT NULL OR photo_probe_version<2)
    AND ((size BETWEEN 1 AND 67108864 AND mime_type IN
          ('image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif'))
        OR (size BETWEEN 1 AND 85899345920 AND mime_type IN ('video/mp4','video/webm','video/quicktime')));
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='5s';

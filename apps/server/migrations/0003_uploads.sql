-- Inventory is deliberately retained after terminal states: late S3 work has no finite
-- visibility guarantee. No FK cascade may erase the exact key needed for reconciliation.
CREATE TABLE hyori_uploads (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    uploader_id text,
    grant_digests jsonb NOT NULL DEFAULT '[]',
    parent_id text,
    name text NOT NULL,
    size bigint NOT NULL CHECK (size BETWEEN 0 AND 83886080000),
    mime_type text NOT NULL,
    object_key text NOT NULL UNIQUE,
    multipart_id text,
    replace_id text,
    replace_revision bigint,
    state text NOT NULL CHECK (state IN ('starting','uploading','finalizing','complete','aborted')),
    file_id text,
    result jsonb,
    reservation_held boolean NOT NULL DEFAULT true,
    lease_token text,
    lease_until timestamptz,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    cleanup_due timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
    cleanup_token text,
    cleanup_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state IN ('complete','aborted')) = NOT reservation_held),
    CHECK ((state = 'complete') = (file_id IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX hyori_uploads_cleanup ON hyori_uploads(cleanup_due,id);
CREATE INDEX hyori_uploads_owner ON hyori_uploads(owner_id,id);
CREATE INDEX hyori_uploads_reserved ON hyori_uploads(owner_id,id) WHERE reservation_held;
CREATE TABLE hyori_upload_parts (
    upload_id text NOT NULL REFERENCES hyori_uploads(id),
    part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
    size bigint NOT NULL CHECK (size BETWEEN 0 AND 8388608),
    etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 1024),
    PRIMARY KEY(upload_id,part_number)
);
-- One charge per distinct retained immutable object, independent of history references.
CREATE TABLE hyori_objects (
    object_key text PRIMARY KEY,
    owner_id text NOT NULL,
    size bigint NOT NULL CHECK (size >= 0)
);
INSERT INTO hyori_objects(object_key,owner_id,size)
SELECT object_key,owner_id,max(size) FROM (
    SELECT object_key,owner_id,size FROM hyori_items WHERE object_key IS NOT NULL
    UNION ALL SELECT object_key,owner_id,size FROM hyori_versions
) retained GROUP BY object_key,owner_id;

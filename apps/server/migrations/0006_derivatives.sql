CREATE TABLE hyori_media_jobs (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    source_key text NOT NULL,
    source_size bigint NOT NULL CHECK (source_size>=0),
    source_mime text NOT NULL,
    recipe integer NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','processing','ready','unsupported','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
    failure text,
    artifact_id text,
    due_at timestamptz NOT NULL DEFAULT now(),
    lease_token text,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(source_key,recipe)
);
CREATE INDEX hyori_media_jobs_due ON hyori_media_jobs(due_at,id) WHERE state IN ('queued','processing');
CREATE INDEX hyori_media_jobs_owner ON hyori_media_jobs(owner_id,id);
CREATE INDEX hyori_items_current_object ON hyori_items(object_key) WHERE trashed_at IS NULL;
-- Every derivative begin has a committed exact-key intent. Retain it after failures and account purge.
CREATE TABLE hyori_media_artifacts (
    id text PRIMARY KEY,
    job_id text NOT NULL,
    owner_id text NOT NULL,
    object_key text NOT NULL UNIQUE,
    multipart_id text,
    state text NOT NULL CHECK (state IN ('starting','ready','aborted')),
    size bigint,
    width integer,
    height integer,
    cleanup_due timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
    cleanup_token text,
    cleanup_until timestamptz,
    checked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (state<>'ready' OR (size BETWEEN 1 AND 262144 AND width BETWEEN 1 AND 256 AND height BETWEEN 1 AND 256))
);
CREATE INDEX hyori_media_artifacts_due ON hyori_media_artifacts(cleanup_due,id);
CREATE INDEX hyori_media_artifacts_owner ON hyori_media_artifacts(owner_id,id);

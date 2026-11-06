-- Retired-ID fence v1: 128 KiB, seven SHA-256-derived 20-bit positions.
-- Checksums detect malformed state; a false-positive only denies a new ID.
ALTER TABLE hyori_editor_sessions
    ADD COLUMN retired_ids_version integer NOT NULL DEFAULT 1 CHECK (retired_ids_version = 1),
    ADD COLUMN retired_ids bytea NOT NULL DEFAULT decode(repeat('00',131072),'hex') CHECK (octet_length(retired_ids)=131072),
    ADD COLUMN retired_ids_sha256 text NOT NULL DEFAULT 'fa43239bcee7b97ca62f007cc68487560a39e19f74f3dde7486db3f98df8e471',
    ADD COLUMN outcome_sequence bigint NOT NULL DEFAULT 0 CHECK (outcome_sequence>=0),
    ADD COLUMN checkpoint_at timestamptz,
    ADD COLUMN last_auto_upload_id text,
    ADD COLUMN last_auto_revision bigint;
ALTER TABLE hyori_editor_saves ADD COLUMN outcome_sequence bigint;
WITH ranked AS (
    SELECT s.session_id,s.save_id,row_number() OVER (PARTITION BY s.session_id ORDER BY u.created_at,u.id) AS sequence
    FROM hyori_editor_saves s JOIN hyori_uploads u ON u.id=s.upload_id WHERE s.result IS NOT NULL
)
UPDATE hyori_editor_saves s SET outcome_sequence=r.sequence FROM ranked r
WHERE s.session_id=r.session_id AND s.save_id=r.save_id;
UPDATE hyori_editor_sessions s SET outcome_sequence=r.sequence FROM
    (SELECT session_id,max(outcome_sequence) AS sequence FROM hyori_editor_saves GROUP BY session_id) r
WHERE r.session_id=s.id AND r.sequence IS NOT NULL;
CREATE UNIQUE INDEX hyori_editor_saves_outcome ON hyori_editor_saves(session_id,outcome_sequence) WHERE outcome_sequence IS NOT NULL;
ALTER TABLE hyori_uploads
    ADD COLUMN editor_superseded boolean NOT NULL DEFAULT false,
    ADD COLUMN editor_reclaimed_at timestamptz;
CREATE INDEX hyori_uploads_editor_reclaim ON hyori_uploads(cleanup_due,id)
    WHERE editor_superseded AND editor_reclaimed_at IS NULL;
-- Reference-safe exact-key collection must also see trash and cross-file history references.
CREATE INDEX hyori_items_retained_object ON hyori_items(object_key) WHERE object_key IS NOT NULL;
CREATE INDEX hyori_versions_retained_object ON hyori_versions(object_key);
CREATE INDEX hyori_uploads_recovery_revision ON hyori_uploads(replace_id,replace_revision)
    WHERE state NOT IN ('complete','aborted');

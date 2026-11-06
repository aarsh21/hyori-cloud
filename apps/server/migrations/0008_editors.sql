-- Persistence capability is separate from permission to distribute executable editor assets.
CREATE TABLE hyori_editor_assets (
    app text PRIMARY KEY,
    version text NOT NULL,
    enabled boolean NOT NULL DEFAULT false
);
INSERT INTO hyori_editor_assets(app,version) VALUES
 ('wordcraft','0.14.0'), ('gridcraft','0.15.0'),
 ('deckcraft','0.14.1-hyori-host.1'), ('pdfcraft','0.17.0');

CREATE TABLE hyori_editor_sessions (
    id text PRIMARY KEY,
    file_id text NOT NULL,
    owner_id text NOT NULL,
    initiator_id text,
    grant_digests jsonb NOT NULL,
    principal text NOT NULL,
    app text NOT NULL REFERENCES hyori_editor_assets(app),
    version text NOT NULL,
    revision bigint NOT NULL,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX hyori_editor_sessions_principal ON hyori_editor_sessions(owner_id,principal);
CREATE INDEX hyori_editor_sessions_expiry ON hyori_editor_sessions(expires_at,id);
CREATE INDEX hyori_editor_sessions_initiator ON hyori_editor_sessions(initiator_id,id);
CREATE INDEX hyori_editor_sessions_file ON hyori_editor_sessions(file_id,id);

ALTER TABLE hyori_uploads ADD COLUMN editor_bound boolean NOT NULL DEFAULT false;
ALTER TABLE hyori_upload_parts ADD COLUMN editor_sha256 text;
CREATE TABLE hyori_editor_saves (
    session_id text NOT NULL REFERENCES hyori_editor_sessions(id),
    save_id text NOT NULL,
    upload_id text NOT NULL UNIQUE REFERENCES hyori_uploads(id),
    destination_owner_id text NOT NULL,
    fingerprint text NOT NULL,
    sha256 text NOT NULL,
    expected_revision bigint NOT NULL,
    intent text NOT NULL CHECK (intent IN ('replace','save-as','export')),
    result jsonb,
    PRIMARY KEY(session_id,save_id)
);
CREATE INDEX hyori_editor_saves_destination_owner ON hyori_editor_saves(destination_owner_id,upload_id);
-- No cascading deletion: retention and account purge remove bounded batches of saves first.

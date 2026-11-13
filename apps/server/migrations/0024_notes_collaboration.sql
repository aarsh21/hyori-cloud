-- Notes content has one authority: a committed Yrs document. Item rows continue to own permissions,
-- hierarchy and trash, so Notes never invents another sharing or administrative privacy model.
CREATE TABLE hyori_collab_documents (
    item_id text PRIMARY KEY REFERENCES hyori_items(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES hyori_users(id),
    kind text NOT NULL CHECK (kind = 'note'),
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    generation text NOT NULL,
    state bytea NOT NULL DEFAULT '\x0000' CHECK (octet_length(state) <= 1048576),
    sequence bigint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE hyori_note_favorites (
    user_id text NOT NULL REFERENCES hyori_users(id) ON DELETE CASCADE,
    item_id text NOT NULL REFERENCES hyori_collab_documents(item_id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,item_id)
);
CREATE TABLE hyori_collab_sessions (
    id text PRIMARY KEY,
    item_id text NOT NULL REFERENCES hyori_collab_documents(item_id) ON DELETE CASCADE,
    principal text NOT NULL,
    client_id text NOT NULL,
    presence text NOT NULL DEFAULT '{}',
    seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours',
    UNIQUE(item_id,client_id)
);
CREATE INDEX hyori_collab_session_principal ON hyori_collab_sessions(principal,expires_at);
CREATE INDEX hyori_collab_session_item ON hyori_collab_sessions(item_id,seen_at);
CREATE TABLE hyori_collab_checkpoints (
    id text PRIMARY KEY,
    item_id text NOT NULL REFERENCES hyori_collab_documents(item_id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES hyori_users(id),
    name text NOT NULL,
    state bytea NOT NULL CHECK (octet_length(state) <= 1048576),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hyori_collab_checkpoint_item ON hyori_collab_checkpoints(item_id,created_at DESC,id DESC);

-- Count live state and retained checkpoints against the existing owner's quota. This also
-- releases their charge for ordinary permanent deletion and the account-purge FK cascade.
CREATE FUNCTION hyori_collab_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner text; delta bigint;
BEGIN
    IF TG_OP = 'INSERT' THEN delta := octet_length(NEW.state); owner := NEW.owner_id;
    ELSIF TG_OP = 'DELETE' THEN delta := -octet_length(OLD.state); owner := OLD.owner_id;
    ELSE delta := octet_length(NEW.state)-octet_length(OLD.state); owner := NEW.owner_id;
    END IF;
    IF delta > 0 THEN
        UPDATE hyori_users SET used_bytes=used_bytes+delta WHERE id=owner
            AND used_bytes+reserved_bytes+delta <= quota_bytes;
        IF NOT FOUND THEN RAISE EXCEPTION 'collaboration quota exceeded' USING ERRCODE='HC001'; END IF;
    ELSIF delta < 0 THEN
        UPDATE hyori_users SET used_bytes=greatest(0,used_bytes+delta) WHERE id=owner;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER hyori_collab_document_quota AFTER INSERT OR UPDATE OF state OR DELETE ON hyori_collab_documents
    FOR EACH ROW EXECUTE FUNCTION hyori_collab_quota();
CREATE TRIGGER hyori_collab_checkpoint_quota AFTER INSERT OR DELETE ON hyori_collab_checkpoints
    FOR EACH ROW EXECUTE FUNCTION hyori_collab_quota();

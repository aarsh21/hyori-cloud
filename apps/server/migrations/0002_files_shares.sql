CREATE TABLE hyori_items (
    id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
    owner_id text NOT NULL REFERENCES hyori_users(id),
    parent_id text REFERENCES hyori_items(id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    kind text NOT NULL CHECK (kind IN ('file', 'folder')),
    size bigint NOT NULL DEFAULT 0 CHECK (size BETWEEN 0 AND 9007199254740991),
    mime_type text NOT NULL,
    object_key text,
    uploaded_by text REFERENCES hyori_users(id) ON DELETE SET NULL,
    ancestor_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ancestor_ids) = 'array' AND jsonb_array_length(ancestor_ids) <= 63),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    trash_root text,
    trashed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((trashed_at IS NULL) = (trash_root IS NULL)),
    CHECK (kind <> 'folder' OR (object_key IS NULL AND size = 0))
);
-- NULL roots participate in uniqueness just like ordinary parents (PostgreSQL 15+).
CREATE UNIQUE INDEX hyori_items_active_name ON hyori_items(owner_id, parent_id, name) NULLS NOT DISTINCT WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_owner_cursor ON hyori_items(owner_id, id);
CREATE INDEX hyori_items_parent_cursor ON hyori_items(parent_id, id) WHERE trashed_at IS NULL;
CREATE INDEX hyori_items_ancestors ON hyori_items USING gin(ancestor_ids);
CREATE INDEX hyori_items_trash ON hyori_items(owner_id, id) WHERE trashed_at IS NOT NULL AND trash_root = id;
CREATE INDEX hyori_items_created ON hyori_items(created_at DESC, id DESC) WHERE trashed_at IS NULL AND kind = 'file';

CREATE TABLE hyori_versions (
    id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
    file_id text NOT NULL REFERENCES hyori_items(id) ON DELETE CASCADE,
    owner_id text NOT NULL REFERENCES hyori_users(id),
    object_key text NOT NULL,
    size bigint NOT NULL CHECK (size BETWEEN 0 AND 9007199254740991),
    mime_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hyori_versions_file_cursor ON hyori_versions(file_id, id);
CREATE INDEX hyori_versions_owner ON hyori_versions(owner_id, id);
CREATE INDEX hyori_versions_object ON hyori_versions(file_id, object_key);

CREATE TABLE hyori_shares (
    id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
    item_id text NOT NULL REFERENCES hyori_items(id) ON DELETE CASCADE,
    issuer_id text NOT NULL REFERENCES hyori_users(id),
    recipient_id text REFERENCES hyori_users(id),
    public boolean NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'contributor', 'editor')),
    token_digest text UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    password_hash text,
    expires_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (public = (recipient_id IS NULL)),
    CHECK (public = (token_digest IS NOT NULL)),
    CHECK (public OR password_hash IS NULL)
);
CREATE UNIQUE INDEX hyori_shares_direct ON hyori_shares(item_id, recipient_id) WHERE revoked_at IS NULL AND recipient_id IS NOT NULL;
CREATE INDEX hyori_shares_item ON hyori_shares(item_id, id) WHERE revoked_at IS NULL;
CREATE INDEX hyori_shares_recipient ON hyori_shares(recipient_id, id) WHERE revoked_at IS NULL;
CREATE INDEX hyori_shares_issuer ON hyori_shares(issuer_id, id);
CREATE TABLE hyori_grants (
    token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    share_id text NOT NULL REFERENCES hyori_shares(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at <= created_at + interval '12 hours')
);
CREATE INDEX hyori_grants_share ON hyori_grants(share_id);
CREATE INDEX hyori_grants_expiry ON hyori_grants(expires_at);

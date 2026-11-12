CREATE TABLE hyori_users (
    id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,128}$'),
    email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    role text NOT NULL CHECK (role IN ('admin', 'user')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted')),
    quota_bytes bigint NOT NULL CHECK (quota_bytes BETWEEN 0 AND 9007199254740991),
    used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes BETWEEN 0 AND 9007199254740991),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes BETWEEN 0 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hyori_bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    initialized boolean NOT NULL DEFAULT false,
    admin_id text REFERENCES hyori_users(id),
    CHECK (initialized = (admin_id IS NOT NULL))
);
INSERT INTO hyori_bootstrap(singleton) VALUES (true);
CREATE TABLE hyori_credentials (
    id text PRIMARY KEY,
    user_id text NOT NULL UNIQUE REFERENCES hyori_users(id) ON DELETE CASCADE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hyori_sessions (
    id text PRIMARY KEY,
    token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    user_id text NOT NULL REFERENCES hyori_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at <= created_at + interval '7 days')
);
CREATE INDEX hyori_sessions_user ON hyori_sessions(user_id);
CREATE INDEX hyori_sessions_expiry ON hyori_sessions(expires_at);
CREATE TABLE hyori_invites (
    token_digest text PRIMARY KEY CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    issuer_id text NOT NULL REFERENCES hyori_users(id),
    email text,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hyori_invites_issuer ON hyori_invites(issuer_id);
CREATE INDEX hyori_invites_expiry ON hyori_invites(expires_at);
CREATE TABLE hyori_rate_limits (
    key_digest text PRIMARY KEY CHECK (key_digest ~ '^[a-f0-9]{64}$'),
    window_start timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 11)
);
CREATE INDEX hyori_rate_limits_expiry ON hyori_rate_limits(window_start);

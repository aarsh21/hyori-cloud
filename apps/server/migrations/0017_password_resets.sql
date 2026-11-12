-- One outstanding reset per account; replacing it invalidates the previous token.
CREATE TABLE hyori_password_resets (
    user_id text PRIMARY KEY REFERENCES hyori_users(id) ON DELETE CASCADE,
    token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at <= created_at + interval '24 hours')
);

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX hyori_users_active_name_trgm ON hyori_users USING gin (lower(name) gin_trgm_ops)
    WHERE status = 'active';
CREATE INDEX hyori_users_active_email_trgm ON hyori_users USING gin (email gin_trgm_ops)
    WHERE status = 'active';
CREATE INDEX hyori_users_active_name_prefix ON hyori_users (lower(name) COLLATE "C", id)
    WHERE status = 'active';
CREATE INDEX hyori_users_active_email_prefix ON hyori_users (email COLLATE "C", id)
    WHERE status = 'active';

-- Opening a public link no longer stores a grant row: the visitor holds a signed capability.
-- An anonymous editor session records which links it was opened through and when the last of
-- the visitor's credentials expires, so cleanup can tell it has ended without a grant row.
-- Sessions opened before this keep both NULL and are judged by their stored grants as before.
ALTER TABLE hyori_editor_sessions ADD COLUMN link_shares jsonb, ADD COLUMN link_expires_at timestamptz;

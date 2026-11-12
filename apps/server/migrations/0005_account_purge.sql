CREATE TABLE hyori_account_purges (
    user_id text PRIMARY KEY REFERENCES hyori_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    due_at timestamptz NOT NULL DEFAULT now(),
    lease_token text,
    lease_until timestamptz,
    completed_at timestamptz,
    deleted_objects bigint NOT NULL DEFAULT 0 CHECK (deleted_objects >= 0)
);
CREATE INDEX hyori_account_purges_due ON hyori_account_purges(due_at,user_id);
-- A key can be relevant to both a deleted contributor and a subsequently deleted destination owner.
-- Neither account cleanup nor FK cascades may discard this late-work reconciliation inventory.
CREATE TABLE hyori_account_purge_uploads (
    user_id text NOT NULL REFERENCES hyori_account_purges(user_id),
    upload_id text NOT NULL REFERENCES hyori_uploads(id),
    PRIMARY KEY(user_id,upload_id)
);
ALTER TABLE hyori_uploads ADD COLUMN purged boolean NOT NULL DEFAULT false;
ALTER TABLE hyori_uploads ADD COLUMN purge_checked_at timestamptz;
CREATE INDEX hyori_uploads_uploader ON hyori_uploads(uploader_id,id) WHERE uploader_id IS NOT NULL;
CREATE INDEX hyori_items_uploader ON hyori_items(uploaded_by,id) WHERE uploaded_by IS NOT NULL;
CREATE INDEX hyori_items_parent_all ON hyori_items(parent_id,id);
CREATE INDEX hyori_photo_album_items_file ON hyori_photo_album_items(file_id,album_id);
CREATE INDEX hyori_objects_owner ON hyori_objects(owner_id,object_key);
CREATE INDEX hyori_invites_email ON hyori_invites(email,token_digest) WHERE email IS NOT NULL;

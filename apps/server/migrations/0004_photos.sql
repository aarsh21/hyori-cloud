CREATE TABLE hyori_photo_sources (
    user_id text PRIMARY KEY REFERENCES hyori_users(id),
    all_my_files boolean NOT NULL DEFAULT false,
    folder_ids jsonb NOT NULL DEFAULT '[]',
    CHECK (jsonb_typeof(folder_ids) = 'array' AND jsonb_array_length(folder_ids) <= 100)
);
CREATE TABLE hyori_photo_albums (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES hyori_users(id),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hyori_photo_albums_owner ON hyori_photo_albums(owner_id, created_at DESC, id DESC);
-- References intentionally survive trash/revocation. They never confer read authority.
CREATE TABLE hyori_photo_album_items (
    album_id text NOT NULL REFERENCES hyori_photo_albums(id) ON DELETE CASCADE,
    file_id text NOT NULL,
    PRIMARY KEY (album_id, file_id)
);
CREATE INDEX hyori_items_media_timeline ON hyori_items(created_at DESC, id DESC)
    WHERE kind='file' AND trashed_at IS NULL AND mime_type IN
    ('image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime');
CREATE INDEX hyori_items_owner_media_timeline ON hyori_items(owner_id, created_at DESC, id DESC)
    WHERE kind='file' AND trashed_at IS NULL;

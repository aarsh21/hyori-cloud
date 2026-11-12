-- Library-root listing walks only the actor's own active root entries in keyset order.
CREATE INDEX hyori_items_owner_root ON hyori_items(owner_id, id) WHERE parent_id IS NULL AND trashed_at IS NULL;
-- Account purge reaches its album memberships in membership-key order without scanning every album.
CREATE INDEX hyori_photo_albums_owner_id ON hyori_photo_albums(owner_id, id);

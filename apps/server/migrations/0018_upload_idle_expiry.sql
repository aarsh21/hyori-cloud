-- NULL preserves every existing reservation's expiry, including legacy owner uploads.
-- New owner reservations opt in explicitly; contributions retain their separate idle policy.
ALTER TABLE hyori_uploads ADD COLUMN idle_seconds bigint CHECK (idle_seconds > 0);
CREATE INDEX hyori_uploads_uploader_pending ON hyori_uploads(uploader_id,id) WHERE reservation_held;
